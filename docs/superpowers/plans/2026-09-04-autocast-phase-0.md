# autocast Phase 0 — Foundations and validate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working `autocast` CLI that can validate a demo script statically and report missing system dependencies — with zero capture, encoding, or browser code.

**Architecture:** A Zod schema is the single source of truth for the demo-script format; TypeScript types are inferred from it and JSON Schema is generated from it, so the three can never drift. YAML is parsed with position tracking so every diagnostic points at a real line and column. Validation runs in two stages — schema shape, then semantic lint — and both emit the same `Diagnostic` shape to one formatter.

**Tech Stack:** TypeScript 5.9 on Node 20+, ESM. `zod` v4 (schema + JSON Schema generation), `yaml` v2 (parsing with source positions), `vitest` v3 (tests). CLI argument parsing uses `node:util`'s built-in `parseArgs` — no dependency. Total runtime dependencies: 2.

**Spec:** `docs/superpowers/specs/2026-09-04-autocast-design.md`

## Global Constraints

- **Node 20+**, `"type": "module"`, ESM throughout. No CommonJS.
- **Windows, macOS and Linux are all first-class.** No POSIX-only assumptions — no shelling out to `which`, no hardcoded `/` path separators, no reliance on a POSIX shell.
- **Runtime dependencies are limited to `yaml` and `zod`.** Do not add others in this phase. Dev dependencies: `typescript`, `vitest`, `@types/node`.
- **Total system dependencies: ffmpeg.** Nothing else may be required to run Phase 0.
- **The only capture-adjacent work permitted in this phase is detection.** No `node-pty`, no Playwright, no ffmpeg invocation beyond `ffmpeg -version`.
- **TDD is mandatory.** Every task writes a failing test first, watches it fail, then implements.
- **Diagnostics must always carry a source location.** A diagnostic with no line number is a bug.
- **Exit codes:** `0` = success (warnings allowed), `1` = validation or check errors, `2` = usage or I/O error.
- Spec section references in this plan (`§4.5`, `§5`, etc.) refer to the spec named above.

---

### Task 1: Project scaffold and CLI shell

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/cli/run.ts`
- Create: `src/cli/index.ts`
- Test: `src/cli/run.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `interface CliIO { out(text: string): void; err(text: string): void }`
  - `async function runCli(argv: string[], io: CliIO): Promise<number>` — `argv` excludes `node` and the script path. Returns the process exit code. Every later command task registers itself inside this function.

- [ ] **Step 1: Write the failing test**

Create `src/cli/run.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('runCli', () => {
  it('prints the version with --version', async () => {
    const c = captureIO();
    const code = await runCli(['--version'], c.io);
    expect(code).toBe(0);
    expect(c.out()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints usage with --help', async () => {
    const c = captureIO();
    const code = await runCli(['--help'], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain('autocast');
    expect(c.out()).toContain('validate');
  });

  it('prints usage and exits 2 when no command is given', async () => {
    const c = captureIO();
    const code = await runCli([], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('no command given');
  });

  it('exits 2 on an unknown command', async () => {
    const c = captureIO();
    const code = await runCli(['frobnicate'], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('unknown command "frobnicate"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/run.test.ts`
Expected: FAIL — cannot resolve `./run.js`.

- [ ] **Step 3: Create the project files**

`package.json`:

```json
{
  "name": "autocast",
  "version": "0.0.0",
  "description": "Agent-driven demo video recorder for web and non-web projects",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "autocast": "./dist/cli/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "yaml": "^2.7.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

`.gitignore`:

```
node_modules/
dist/
coverage/
.autocast/
*.tsbuildinfo
```

Then run: `npm install`

- [ ] **Step 4: Write the CLI shell**

Create `src/cli/run.ts`:

```ts
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export const VERSION = '0.0.0';

const USAGE = `autocast ${VERSION} — agent-driven demo video recorder

Usage:
  autocast <command> [options]

Commands:
  validate <file>   Check a demo script without running it
  doctor            Check system dependencies
  schema            Print the demo-script JSON Schema

Options:
  --version         Print the version
  --help            Print this message`;

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  if (argv.includes('--version')) {
    io.out(VERSION);
    return 0;
  }

  if (argv.includes('--help') || argv[0] === 'help') {
    io.out(USAGE);
    return 0;
  }

  const command = argv[0];
  if (command === undefined) {
    io.err('autocast: no command given\n');
    io.err(USAGE);
    return 2;
  }

  io.err(`autocast: unknown command "${command}"\n`);
  io.err(USAGE);
  return 2;
}
```

Create `src/cli/index.ts`:

```ts
#!/usr/bin/env node
import { runCli, type CliIO } from './run.js';

const io: CliIO = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

runCli(process.argv.slice(2), io).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    io.err(`autocast: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cli/run.test.ts`
Expected: PASS — 4 tests.

Then run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/cli/
git commit -m "feat: project scaffold and CLI shell"
```

---

### Task 2: Demo script schema

**Files:**
- Create: `src/schema/pattern.ts`
- Create: `src/schema/demo.ts`
- Test: `src/schema/pattern.test.ts`
- Test: `src/schema/demo.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `function compilePattern(source: string): RegExp | null` — returns `null` when `source` is `/…/flags` form but does not compile. A plain string (no leading `/`) yields a literal-substring matcher compiled with escaping.
  - `const DemoScript: z.ZodType` — the Zod schema for a whole demo file.
  - `type DemoScript = z.infer<typeof DemoScript>` — the inferred TypeScript type.
  - `const TERMINAL_STEP_KEYS`, `BROWSER_STEP_KEYS`, `TERMINAL_ASSERT_KEYS`, `BROWSER_ASSERT_KEYS`: `ReadonlySet<string>` — used by Task 6's backend-mismatch lint.

- [ ] **Step 1: Write the failing pattern test**

Create `src/schema/pattern.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compilePattern } from './pattern.js';

describe('compilePattern', () => {
  it('compiles a /regex/ form', () => {
    const re = compilePattern('/listening on :\\d+/');
    expect(re).not.toBeNull();
    expect(re!.test('listening on :3000')).toBe(true);
  });

  it('honours flags after the closing slash', () => {
    const re = compilePattern('/HELLO/i');
    expect(re!.test('hello')).toBe(true);
  });

  it('returns null for a /regex/ that does not compile', () => {
    expect(compilePattern('/listening on :30(0/')).toBeNull();
  });

  it('treats a plain string as a literal substring', () => {
    const re = compilePattern('a.b');
    expect(re!.test('a.b')).toBe(true);
    expect(re!.test('axb')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/schema/pattern.test.ts`
Expected: FAIL — cannot resolve `./pattern.js`.

- [ ] **Step 3: Implement pattern compilation**

Create `src/schema/pattern.ts`:

```ts
/**
 * A Pattern is either `/source/flags` (a regular expression) or a plain
 * string (matched as a literal substring). YAML has no regex type, so
 * `stdout: /listening on :3000/` arrives here as the string
 * `"/listening on :3000/"`.
 *
 * Returns null when the /…/ form is used but does not compile. Plain
 * strings always compile, because they are escaped first.
 */
export function compilePattern(source: string): RegExp | null {
  if (source.startsWith('/')) {
    const end = source.lastIndexOf('/');
    if (end <= 0) return null;
    try {
      return new RegExp(source.slice(1, end), source.slice(end + 1));
    } catch {
      return null;
    }
  }
  return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
```

- [ ] **Step 4: Run pattern tests to verify they pass**

Run: `npx vitest run src/schema/pattern.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write the failing schema test**

Create `src/schema/demo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DemoScript } from './demo.js';

const minimal = {
  autocast: 1,
  output: { path: 'docs/demo.mp4' },
  sessions: { api: { backend: 'terminal' } },
  scenes: [{ id: 'boot', use: 'api', steps: [{ type: 'ls' }] }],
};

describe('DemoScript', () => {
  it('accepts a minimal valid script', () => {
    const r = DemoScript.safeParse(minimal);
    expect(r.success).toBe(true);
  });

  it('defaults canvas and fps', () => {
    const r = DemoScript.safeParse(minimal);
    expect(r.success && r.data.output.canvas).toEqual([1280, 720]);
    expect(r.success && r.data.output.fps).toBe(30);
  });

  it('rejects a wrong version literal', () => {
    const r = DemoScript.safeParse({ ...minimal, autocast: 2 });
    expect(r.success).toBe(false);
  });

  it('rejects a step with two action keys', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      scenes: [{ id: 'a', use: 'api', steps: [{ type: 'ls', goto: 'http://x' }] }],
    });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toContain('exactly one action key');
  });

  it('rejects a step with an unknown key', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      scenes: [{ id: 'a', use: 'api', steps: [{ frobnicate: 'ls' }] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an uncompilable regex in wait_for.stdout', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      scenes: [{ id: 'a', use: 'api', steps: [{ wait_for: { stdout: '/oops(/' } }] }],
    });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toContain('regular expression');
  });

  it('rejects a duration that is not a number or ms/s string', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      defaults: { settle: '400 milliseconds' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts a browser session with a cdp attach target', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      sessions: { app: { backend: 'browser', attach: { cdp: 'http://localhost:9222' } } },
      scenes: [{ id: 'a', use: 'app', steps: [{ goto: 'http://x' }] }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts an optional style block', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      style: {
        background: { gradient: ['#1a1a2e', '#16213e'], padding: 64 },
        window: { radius: 12, shadow: true },
        zoom: { auto: true, on: 'click', scale: 1.8, ease: 'spring' },
        cursor: { size: 1.5 },
        motion_blur: { cursor: true, zoom: true, pan: true },
      },
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/schema/demo.test.ts`
Expected: FAIL — cannot resolve `./demo.js`.

- [ ] **Step 7: Implement the schema**

Create `src/schema/demo.ts`:

```ts
import { z } from 'zod';
import { compilePattern } from './pattern.js';

/** A duration: a non-negative integer of milliseconds, or "400ms" / "1.5s". */
const Duration = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+(?:\.\d+)?(?:ms|s)$/, 'duration must look like "400ms" or "1.5s"'),
]);

/** A literal substring, or a `/regex/flags` that must compile. */
const Pattern = z.string().refine((s) => compilePattern(s) !== null, {
  message: 'invalid regular expression',
});

/** True when exactly one key of the object is set. */
function hasExactlyOneKey(value: object): boolean {
  return Object.values(value).filter((v) => v !== undefined).length === 1;
}

const WaitFor = z
  .object({
    stdout: Pattern.optional(),
    selector: z.string().optional(),
    timeout: Duration.optional(),
  })
  .strict()
  .refine((v) => (v.stdout === undefined) !== (v.selector === undefined), {
    message: 'wait_for needs exactly one of stdout or selector',
  });

const Step = z
  .object({
    type: z.string().optional(),
    key: z.string().optional(),
    goto: z.string().optional(),
    click: z.string().optional(),
    fill: z.object({ selector: z.string(), value: z.string() }).strict().optional(),
    run: z.string().optional(),
    sleep: Duration.optional(),
    wait_for: WaitFor.optional(),
  })
  .strict()
  .refine(hasExactlyOneKey, { message: 'a step must have exactly one action key' });

const Assertion = z
  .object({
    process_alive: z.boolean().optional(),
    exit_code: z.number().int().optional(),
    stdout_contains: z.string().optional(),
    stdout_matches: Pattern.optional(),
    stderr_empty: z.boolean().optional(),
    visible: z.string().optional(),
    hidden: z.string().optional(),
    text_matches: Pattern.optional(),
    url_matches: Pattern.optional(),
    no_console_errors: z.boolean().optional(),
    no_failed_requests: z.boolean().optional(),
  })
  .strict()
  .refine(hasExactlyOneKey, { message: 'an assertion must have exactly one action key' });

/** Step keys that only make sense against a given backend. See §5. */
export const BROWSER_STEP_KEYS: ReadonlySet<string> = new Set(['goto', 'click', 'fill']);
export const TERMINAL_STEP_KEYS: ReadonlySet<string> = new Set(['run']);
export const BROWSER_ASSERT_KEYS: ReadonlySet<string> = new Set([
  'visible', 'hidden', 'text_matches', 'url_matches',
  'no_console_errors', 'no_failed_requests',
]);
export const TERMINAL_ASSERT_KEYS: ReadonlySet<string> = new Set([
  'process_alive', 'exit_code', 'stdout_contains', 'stdout_matches', 'stderr_empty',
]);

const TerminalSession = z
  .object({
    backend: z.literal('terminal'),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  })
  .strict();

const BrowserSession = z
  .object({
    backend: z.literal('browser'),
    viewport: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    attach: z.object({ cdp: z.string() }).strict().optional(),
  })
  .strict();

const Session = z.discriminatedUnion('backend', [TerminalSession, BrowserSession]);

const Layout = z
  .object({
    primary: z.string(),
    inset: z
      .object({
        session: z.string(),
        corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
        scale: z.number().positive().max(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const Scene = z
  .object({
    id: z.string().min(1),
    use: z.string().min(1),
    narrate: z.string().optional(),
    focus: z.string().optional(),
    layout: Layout.optional(),
    steps: z.array(Step).optional(),
    assert: z.array(Assertion).optional(),
    sync: z.enum(['hold', 'strict']).optional(),
    on_assert_fail: z.enum(['abort', 'continue', 'warn']).optional(),
  })
  .strict();

/** Phase 5. Validated now so styled scripts are forward-compatible. */
const Style = z
  .object({
    background: z
      .object({
        gradient: z.array(z.string()).min(2).optional(),
        color: z.string().optional(),
        padding: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    window: z
      .object({
        radius: z.number().int().nonnegative().optional(),
        shadow: z.boolean().optional(),
      })
      .strict()
      .optional(),
    zoom: z
      .object({
        auto: z.boolean().optional(),
        on: z.enum(['click', 'focus']).optional(),
        scale: z.number().positive().optional(),
        ease: z.enum(['spring', 'cubic']).optional(),
      })
      .strict()
      .optional(),
    cursor: z.object({ size: z.number().positive().optional() }).strict().optional(),
    motion_blur: z
      .object({
        cursor: z.boolean().optional(),
        zoom: z.boolean().optional(),
        pan: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DemoScript = z
  .object({
    autocast: z.literal(1),
    output: z
      .object({
        path: z.string().min(1),
        canvas: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
          .default([1280, 720]),
        fps: z.number().int().positive().default(30),
      })
      .strict(),
    defaults: z
      .object({ typing_speed: Duration.optional(), settle: Duration.optional() })
      .strict()
      .optional(),
    style: Style.optional(),
    sessions: z.record(z.string().min(1), Session),
    scenes: z.array(Scene).min(1),
  })
  .strict();

export type DemoScript = z.infer<typeof DemoScript>;
export type Scene = z.infer<typeof Scene>;
export type Session = z.infer<typeof Session>;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/schema/`
Expected: PASS — 13 tests across both files.

- [ ] **Step 9: Commit**

```bash
git add src/schema/
git commit -m "feat: demo script schema with pattern validation"
```

---

### Task 3: YAML parsing with source positions

**Files:**
- Create: `src/validate/parse.ts`
- Test: `src/validate/parse.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `interface SourceLocation { line: number; col: number }` — both 1-based.
  - `interface SyntaxProblem { message: string; loc: SourceLocation }`
  - `interface ParsedSource { value: unknown; syntaxErrors: SyntaxProblem[]; locate(path: ReadonlyArray<string | number>): SourceLocation }`
  - `function parseSource(text: string): ParsedSource` — `locate` walks up the path until a node resolves, so a diagnostic about a missing key points at its parent. Falls back to `{ line: 1, col: 1 }`.

- [ ] **Step 1: Write the failing test**

Create `src/validate/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSource } from './parse.js';

const SAMPLE = `autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
`;

describe('parseSource', () => {
  it('returns the parsed value', () => {
    const p = parseSource(SAMPLE);
    expect((p.value as Record<string, unknown>).autocast).toBe(1);
  });

  it('locates a top-level key', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['sessions'])).toEqual({ line: 4, col: 1 });
  });

  it('locates a nested scalar', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['output', 'path'])).toEqual({ line: 3, col: 9 });
  });

  it('locates an array element by index', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['scenes', 0, 'use'])).toEqual({ line: 9, col: 10 });
  });

  it('walks up to the parent when the path does not resolve', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['output', 'missing'])).toEqual(p.locate(['output']));
  });

  it('falls back to 1:1 for a wholly unresolvable path', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['nope', 'nothing'])).toEqual({ line: 1, col: 1 });
  });

  it('reports YAML syntax errors with a location', () => {
    const p = parseSource('scenes:\n  - id: a\n   use: b\n');
    expect(p.syntaxErrors.length).toBeGreaterThan(0);
    expect(p.syntaxErrors[0]!.loc.line).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/validate/parse.test.ts`
Expected: FAIL — cannot resolve `./parse.js`.

- [ ] **Step 3: Implement the parser**

Create `src/validate/parse.ts`:

```ts
import { LineCounter, parseDocument, isNode } from 'yaml';

export interface SourceLocation {
  line: number;
  col: number;
}

export interface SyntaxProblem {
  message: string;
  loc: SourceLocation;
}

export interface ParsedSource {
  value: unknown;
  syntaxErrors: SyntaxProblem[];
  /**
   * Map a path into the document to a source position. Walks up the path
   * until something resolves, so a complaint about a key that is absent
   * points at the object that should have contained it.
   */
  locate(path: ReadonlyArray<string | number>): SourceLocation;
}

const START: SourceLocation = { line: 1, col: 1 };

export function parseSource(text: string): ParsedSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });

  const at = (offset: number): SourceLocation => {
    const pos = lineCounter.linePos(offset);
    return { line: pos.line, col: pos.col };
  };

  const syntaxErrors: SyntaxProblem[] = doc.errors.map((e) => ({
    message: e.message,
    loc: e.pos.length > 0 ? at(e.pos[0]!) : START,
  }));

  const locate = (path: ReadonlyArray<string | number>): SourceLocation => {
    const walk = [...path];
    while (walk.length > 0) {
      const node: unknown = doc.getIn(walk, true);
      if (isNode(node) && node.range) {
        return at(node.range[0]);
      }
      walk.pop();
    }
    return START;
  };

  return {
    value: doc.errors.length > 0 ? undefined : doc.toJS({ maxAliasCount: 100 }),
    syntaxErrors,
    locate,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/validate/parse.test.ts`
Expected: PASS — 7 tests. If a column assertion is off by one, correct the *test* to the value the `yaml` package reports — `locate` returning the node's own start offset is the contract, and `yaml`'s columns are authoritative.

- [ ] **Step 5: Commit**

```bash
git add src/validate/parse.ts src/validate/parse.test.ts
git commit -m "feat: YAML parsing with source position lookup"
```

---

### Task 4: Diagnostics and formatting

**Files:**
- Create: `src/validate/diagnostic.ts`
- Test: `src/validate/diagnostic.test.ts`

**Interfaces:**
- Consumes: `SourceLocation` from `src/validate/parse.ts`
- Produces:
  - `type Severity = 'error' | 'warning'`
  - `interface Diagnostic { severity: Severity; code: string; message: string; loc: SourceLocation }`
  - `function formatDiagnostics(file: string, diagnostics: Diagnostic[]): string` — one line per diagnostic plus a summary line.
  - `function hasErrors(diagnostics: Diagnostic[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/validate/diagnostic.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatDiagnostics, hasErrors, type Diagnostic } from './diagnostic.js';

const d = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  severity: 'error',
  code: 'L001',
  message: 'something went wrong',
  loc: { line: 4, col: 7 },
  ...over,
});

describe('formatDiagnostics', () => {
  it('formats a diagnostic as file:line:col severity code message', () => {
    const text = formatDiagnostics('demo.yaml', [d()]);
    expect(text).toContain('demo.yaml:4:7');
    expect(text).toContain('error');
    expect(text).toContain('L001');
    expect(text).toContain('something went wrong');
  });

  it('summarises counts of both severities', () => {
    const text = formatDiagnostics('demo.yaml', [d(), d({ severity: 'warning', code: 'L004' })]);
    expect(text).toContain('1 error');
    expect(text).toContain('1 warning');
  });

  it('reports a clean file', () => {
    expect(formatDiagnostics('demo.yaml', [])).toContain('no problems found');
  });

  it('sorts by line then column', () => {
    const text = formatDiagnostics('demo.yaml', [
      d({ code: 'B', loc: { line: 9, col: 1 } }),
      d({ code: 'A', loc: { line: 2, col: 5 } }),
    ]);
    expect(text.indexOf('A')).toBeLessThan(text.indexOf('B'));
  });
});

describe('hasErrors', () => {
  it('is true when any diagnostic is an error', () => {
    expect(hasErrors([d({ severity: 'warning' }), d()])).toBe(true);
  });

  it('is false for warnings only', () => {
    expect(hasErrors([d({ severity: 'warning' })])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/validate/diagnostic.test.ts`
Expected: FAIL — cannot resolve `./diagnostic.js`.

- [ ] **Step 3: Implement diagnostics**

Create `src/validate/diagnostic.ts`:

```ts
import type { SourceLocation } from './parse.js';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** Stable identifier, e.g. "L001" for lint or "S001" for schema. */
  code: string;
  message: string;
  loc: SourceLocation;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatDiagnostics(file: string, diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return `${file}: no problems found`;
  }

  const sorted = [...diagnostics].sort(
    (a, b) => a.loc.line - b.loc.line || a.loc.col - b.loc.col,
  );

  const lines = sorted.map(
    (d) => `${file}:${d.loc.line}:${d.loc.col}  ${d.severity}  ${d.code}  ${d.message}`,
  );

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  lines.push('', `${plural(errors, 'error')}, ${plural(warnings, 'warning')}`);

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/validate/diagnostic.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/validate/diagnostic.ts src/validate/diagnostic.test.ts
git commit -m "feat: diagnostic type and formatter"
```

---

### Task 5: Schema validation against source positions

**Files:**
- Create: `src/validate/schema-check.ts`
- Test: `src/validate/schema-check.test.ts`

**Interfaces:**
- Consumes: `parseSource`, `ParsedSource` (Task 3); `Diagnostic` (Task 4); `DemoScript` (Task 2)
- Produces:
  - `interface SchemaCheckResult { diagnostics: Diagnostic[]; script: DemoScript | null }`
  - `function checkSchema(parsed: ParsedSource): SchemaCheckResult` — emits `Y001` for YAML syntax errors and `S001` for schema violations. `script` is non-null only when there are no errors.

- [ ] **Step 1: Write the failing test**

Create `src/validate/schema-check.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSource } from './parse.js';
import { checkSchema } from './schema-check.js';

const VALID = `autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
    steps:
      - type: ls
`;

describe('checkSchema', () => {
  it('accepts a valid script and returns it parsed', () => {
    const r = checkSchema(parseSource(VALID));
    expect(r.diagnostics).toEqual([]);
    expect(r.script?.output.fps).toBe(30);
  });

  it('reports a YAML syntax error as Y001 and returns no script', () => {
    const r = checkSchema(parseSource('scenes:\n  - id: a\n   use: b\n'));
    expect(r.diagnostics[0]!.code).toBe('Y001');
    expect(r.script).toBeNull();
  });

  it('points a schema error at the offending line', () => {
    const bad = VALID.replace('backend: terminal', 'backend: telepathy');
    const r = checkSchema(parseSource(bad));
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0]!.code).toBe('S001');
    expect(r.diagnostics[0]!.loc.line).toBe(6);
    expect(r.script).toBeNull();
  });

  it('points a missing required key at its parent object', () => {
    const bad = VALID.replace('    use: api\n', '');
    const r = checkSchema(parseSource(bad));
    expect(r.diagnostics[0]!.code).toBe('S001');
    expect(r.diagnostics[0]!.loc.line).toBe(8);
  });

  it('includes the failing path in the message', () => {
    const bad = VALID.replace('autocast: 1', 'autocast: 2');
    const r = checkSchema(parseSource(bad));
    expect(r.diagnostics[0]!.message).toContain('autocast');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/validate/schema-check.test.ts`
Expected: FAIL — cannot resolve `./schema-check.js`.

- [ ] **Step 3: Implement schema checking**

Create `src/validate/schema-check.ts`:

```ts
import { DemoScript } from '../schema/demo.js';
import type { Diagnostic } from './diagnostic.js';
import type { ParsedSource } from './parse.js';

export interface SchemaCheckResult {
  diagnostics: Diagnostic[];
  script: DemoScript | null;
}

export function checkSchema(parsed: ParsedSource): SchemaCheckResult {
  if (parsed.syntaxErrors.length > 0) {
    return {
      script: null,
      diagnostics: parsed.syntaxErrors.map((e) => ({
        severity: 'error' as const,
        code: 'Y001',
        message: e.message,
        loc: e.loc,
      })),
    };
  }

  const result = DemoScript.safeParse(parsed.value);
  if (result.success) {
    return { diagnostics: [], script: result.data };
  }

  const diagnostics = result.error.issues.map((issue): Diagnostic => {
    const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)) as Array<
      string | number
    >;
    const where = path.length > 0 ? `${path.join('.')}: ` : '';
    return {
      severity: 'error',
      code: 'S001',
      message: `${where}${issue.message}`,
      loc: parsed.locate(path),
    };
  });

  return { diagnostics, script: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/validate/schema-check.test.ts`
Expected: PASS — 5 tests.

> Note on the `backend: telepathy` case: Zod reports discriminated-union
> failures at either the discriminator key or its parent object depending on
> the version. If the diagnostic lands on line 5 (the `api:` key) rather than
> line 6, that is correct behaviour — `locate` walking up to the parent is the
> designed fallback. Adjust the expectation to 5 rather than changing
> `locate`.

- [ ] **Step 5: Commit**

```bash
git add src/validate/schema-check.ts src/validate/schema-check.test.ts
git commit -m "feat: schema validation mapped to source positions"
```

---

### Task 6: Semantic lint rules

**Files:**
- Create: `src/validate/lint.ts`
- Test: `src/validate/lint.test.ts`

**Interfaces:**
- Consumes: `DemoScript`, `BROWSER_STEP_KEYS`, `TERMINAL_STEP_KEYS`, `BROWSER_ASSERT_KEYS`, `TERMINAL_ASSERT_KEYS` (Task 2); `Diagnostic` (Task 4); `ParsedSource` (Task 3)
- Produces:
  - `const NARRATION_WORD_CEILING = 120`
  - `function lint(script: DemoScript, parsed: ParsedSource): Diagnostic[]`

Rules implemented, all referencing spec §8 layer 1:

| Code | Severity | Rule |
|---|---|---|
| L001 | error | `scene.use` names an undeclared session |
| L002 | error | `layout.primary` or `layout.inset.session` names an undeclared session |
| L003 | error | duplicate scene `id` |
| L004 | warning | scene has no assertions |
| L005 | warning | `sleep` step used — prefer `wait_for` |
| L006 | warning | session declared but never referenced |
| L007 | warning | `narrate` exceeds `NARRATION_WORD_CEILING` words |
| L008 | error | step key not valid for the acting session's backend |
| L009 | error | assertion key not valid for the acting session's backend |

- [ ] **Step 1: Write the failing test**

Create `src/validate/lint.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSource } from './parse.js';
import { checkSchema } from './schema-check.js';
import { lint } from './lint.js';

function lintYaml(text: string) {
  const parsed = parseSource(text);
  const { script, diagnostics } = checkSchema(parsed);
  if (!script) throw new Error(`fixture failed schema: ${JSON.stringify(diagnostics)}`);
  return lint(script, parsed);
}

const codes = (text: string) => lintYaml(text).map((d) => d.code);

const BASE = `autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
  web:
    backend: browser
scenes:
`;

describe('lint', () => {
  it('L001: flags a scene using an undeclared session', () => {
    const c = codes(BASE + `  - id: a
    use: nope
    assert:
      - process_alive: true
`);
    expect(c).toContain('L001');
  });

  it('L002: flags a layout referencing an undeclared session', () => {
    const c = codes(BASE + `  - id: a
    use: api
    layout:
      primary: ghost
    assert:
      - process_alive: true
`);
    expect(c).toContain('L002');
  });

  it('L003: flags duplicate scene ids', () => {
    const c = codes(BASE + `  - id: dup
    use: api
    assert:
      - process_alive: true
  - id: dup
    use: web
    assert:
      - visible: ".x"
`);
    expect(c).toContain('L003');
  });

  it('L004: warns on a scene with no assertions', () => {
    const c = codes(BASE + `  - id: a
    use: api
    steps:
      - type: ls
`);
    expect(c).toContain('L004');
  });

  it('L005: warns when sleep is used', () => {
    const c = codes(BASE + `  - id: a
    use: api
    steps:
      - sleep: 500ms
    assert:
      - process_alive: true
`);
    expect(c).toContain('L005');
  });

  it('L006: warns about an unused session', () => {
    const c = codes(BASE + `  - id: a
    use: api
    assert:
      - process_alive: true
`);
    expect(c).toContain('L006');
  });

  it('L007: warns about narration over the word ceiling', () => {
    const long = 'word '.repeat(130).trim();
    const c = codes(BASE + `  - id: a
    use: api
    narrate: "${long}"
    assert:
      - process_alive: true
`);
    expect(c).toContain('L007');
  });

  it('L008: flags a browser step in a terminal session', () => {
    const c = codes(BASE + `  - id: a
    use: api
    steps:
      - goto: http://localhost:3000
    assert:
      - process_alive: true
`);
    expect(c).toContain('L008');
  });

  it('L009: flags a terminal assertion in a browser session', () => {
    const c = codes(BASE + `  - id: a
    use: web
    assert:
      - process_alive: true
`);
    expect(c).toContain('L009');
  });

  it('is silent on a clean script', () => {
    const c = codes(BASE + `  - id: boot
    use: api
    steps:
      - type: npm run dev
      - wait_for:
          stdout: /listening/
    assert:
      - process_alive: true
  - id: order
    use: web
    steps:
      - goto: http://localhost:3000
    assert:
      - visible: ".ok"
`);
    expect(c).toEqual([]);
  });

  it('gives every diagnostic a real source location', () => {
    const ds = lintYaml(BASE + `  - id: a
    use: nope
    assert:
      - process_alive: true
`);
    expect(ds.every((d) => d.loc.line > 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/validate/lint.test.ts`
Expected: FAIL — cannot resolve `./lint.js`.

- [ ] **Step 3: Implement the lint rules**

Create `src/validate/lint.ts`:

```ts
import {
  BROWSER_ASSERT_KEYS,
  BROWSER_STEP_KEYS,
  TERMINAL_ASSERT_KEYS,
  TERMINAL_STEP_KEYS,
  type DemoScript,
} from '../schema/demo.js';
import type { Diagnostic } from './diagnostic.js';
import type { ParsedSource } from './parse.js';

/**
 * True scene duration is unknowable without running the demo, so this is
 * an absolute ceiling that only catches narration too long for *any*
 * plausible scene. See spec §8 layer 1.
 */
export const NARRATION_WORD_CEILING = 120;

export function lint(script: DemoScript, parsed: ParsedSource): Diagnostic[] {
  const out: Diagnostic[] = [];
  const sessionIds = new Set(Object.keys(script.sessions));
  const usedSessions = new Set<string>();
  const seenSceneIds = new Set<string>();

  const add = (
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    path: Array<string | number>,
  ) => {
    out.push({ severity, code, message, loc: parsed.locate(path) });
  };

  const known = () => [...sessionIds].sort().join(', ');

  script.scenes.forEach((scene, i) => {
    if (seenSceneIds.has(scene.id)) {
      add('error', 'L003', `duplicate scene id "${scene.id}"`, ['scenes', i, 'id']);
    }
    seenSceneIds.add(scene.id);

    const backend = sessionIds.has(scene.use) ? script.sessions[scene.use]!.backend : null;
    if (backend === null) {
      add(
        'error',
        'L001',
        `scene "${scene.id}" uses session "${scene.use}", which is not declared. Declared sessions: ${known()}`,
        ['scenes', i, 'use'],
      );
    } else {
      usedSessions.add(scene.use);
    }

    if (scene.layout) {
      const refs: Array<[string, Array<string | number>]> = [
        [scene.layout.primary, ['scenes', i, 'layout', 'primary']],
      ];
      if (scene.layout.inset) {
        refs.push([scene.layout.inset.session, ['scenes', i, 'layout', 'inset', 'session']]);
      }
      for (const [id, path] of refs) {
        if (!sessionIds.has(id)) {
          add(
            'error',
            'L002',
            `layout in scene "${scene.id}" references session "${id}", which is not declared. Declared sessions: ${known()}`,
            path,
          );
        } else {
          usedSessions.add(id);
        }
      }
    }

    if (!scene.assert || scene.assert.length === 0) {
      add(
        'warning',
        'L004',
        `scene "${scene.id}" has no assertions — a demo that silently records an error state is worse than no demo`,
        ['scenes', i, 'id'],
      );
    }

    scene.steps?.forEach((step, j) => {
      const key = Object.keys(step).find((k) => step[k as keyof typeof step] !== undefined);
      if (key === undefined) return;

      if (key === 'sleep') {
        add(
          'warning',
          'L005',
          'sleep makes the render fragile on slower machines — prefer wait_for',
          ['scenes', i, 'steps', j, 'sleep'],
        );
      }

      if (backend === 'terminal' && BROWSER_STEP_KEYS.has(key)) {
        add('error', 'L008', `step "${key}" is browser-only, but session "${scene.use}" is a terminal`, [
          'scenes', i, 'steps', j, key,
        ]);
      }
      if (backend === 'browser' && TERMINAL_STEP_KEYS.has(key)) {
        add('error', 'L008', `step "${key}" is terminal-only, but session "${scene.use}" is a browser`, [
          'scenes', i, 'steps', j, key,
        ]);
      }
      if (backend === 'browser' && key === 'wait_for' && step.wait_for?.stdout !== undefined) {
        add('error', 'L008', 'wait_for.stdout is terminal-only, but this session is a browser', [
          'scenes', i, 'steps', j, 'wait_for', 'stdout',
        ]);
      }
      if (backend === 'terminal' && key === 'wait_for' && step.wait_for?.selector !== undefined) {
        add('error', 'L008', 'wait_for.selector is browser-only, but this session is a terminal', [
          'scenes', i, 'steps', j, 'wait_for', 'selector',
        ]);
      }
    });

    scene.assert?.forEach((assertion, j) => {
      const key = Object.keys(assertion).find(
        (k) => assertion[k as keyof typeof assertion] !== undefined,
      );
      if (key === undefined) return;

      if (backend === 'terminal' && BROWSER_ASSERT_KEYS.has(key)) {
        add('error', 'L009', `assertion "${key}" is browser-only, but session "${scene.use}" is a terminal`, [
          'scenes', i, 'assert', j, key,
        ]);
      }
      if (backend === 'browser' && TERMINAL_ASSERT_KEYS.has(key)) {
        add('error', 'L009', `assertion "${key}" is terminal-only, but session "${scene.use}" is a browser`, [
          'scenes', i, 'assert', j, key,
        ]);
      }
    });

    if (scene.narrate !== undefined) {
      const words = scene.narrate.trim().split(/\s+/).filter(Boolean).length;
      if (words > NARRATION_WORD_CEILING) {
        add(
          'warning',
          'L007',
          `narration in scene "${scene.id}" is ${words} words, over the ${NARRATION_WORD_CEILING}-word ceiling — it will outrun any plausible scene`,
          ['scenes', i, 'narrate'],
        );
      }
    }
  });

  for (const id of sessionIds) {
    if (!usedSessions.has(id)) {
      add('warning', 'L006', `session "${id}" is declared but never used`, ['sessions', id]);
    }
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/validate/lint.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/validate/lint.ts src/validate/lint.test.ts
git commit -m "feat: semantic lint rules L001-L009"
```

---

### Task 7: The validate command and fixtures

**Files:**
- Create: `src/validate/validate.ts`
- Create: `src/cli/validate-command.ts`
- Modify: `src/cli/run.ts`
- Create: `fixtures/mixed/demo.yaml`
- Create: `fixtures/broken/undeclared-session.yaml`
- Create: `fixtures/broken/bad-regex.yaml`
- Create: `fixtures/broken/wrong-backend.yaml`
- Create: `fixtures/broken/yaml-syntax.yaml`
- Create: `fixtures/warnings/no-assertions.yaml`
- Test: `src/validate/validate.test.ts`
- Test: `src/cli/validate-command.test.ts`

**Interfaces:**
- Consumes: `parseSource` (3), `Diagnostic`/`formatDiagnostics`/`hasErrors` (4), `checkSchema` (5), `lint` (6), `runCli`/`CliIO` (1)
- Produces:
  - `function validateText(text: string): Diagnostic[]` — full pipeline over a string.
  - `async function validateCommand(argv: string[], io: CliIO): Promise<number>` — reads the file, prints formatted diagnostics, returns an exit code. Supports `--strict` (warnings become a failure).

- [ ] **Step 1: Write the failing pipeline test**

Create `src/validate/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateText } from './validate.js';

describe('validateText', () => {
  it('passes the flagship fixture with no errors', () => {
    const text = readFileSync('fixtures/mixed/demo.yaml', 'utf8');
    const ds = validateText(text);
    expect(ds.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('reports an undeclared session', () => {
    const text = readFileSync('fixtures/broken/undeclared-session.yaml', 'utf8');
    expect(validateText(text).map((d) => d.code)).toContain('L001');
  });

  it('reports an uncompilable regex', () => {
    const text = readFileSync('fixtures/broken/bad-regex.yaml', 'utf8');
    expect(validateText(text).map((d) => d.code)).toContain('S001');
  });

  it('reports a backend-mismatched step', () => {
    const text = readFileSync('fixtures/broken/wrong-backend.yaml', 'utf8');
    expect(validateText(text).map((d) => d.code)).toContain('L008');
  });

  it('reports a YAML syntax error and does not attempt lint', () => {
    const text = readFileSync('fixtures/broken/yaml-syntax.yaml', 'utf8');
    const codes = validateText(text).map((d) => d.code);
    expect(codes).toContain('Y001');
    expect(codes.some((c) => c.startsWith('L'))).toBe(false);
  });
});
```

- [ ] **Step 2: Write the fixtures**

`fixtures/mixed/demo.yaml` — the flagship from spec §5:

```yaml
autocast: 1
output:
  path: docs/demo.mp4
  canvas: [1280, 720]
  fps: 30

defaults:
  typing_speed: 45ms
  settle: 400ms

style:
  background: { gradient: ["#1a1a2e", "#16213e"], padding: 64 }
  window: { radius: 12, shadow: true }
  zoom: { auto: true, on: click, scale: 1.8, ease: spring }
  cursor: { size: 1.5 }
  motion_blur: { cursor: true, zoom: true, pan: true }

sessions:
  api:
    backend: terminal
    cwd: ./server
    cols: 100
    rows: 28
  web:
    backend: browser
    viewport: [1280, 720]

scenes:
  - id: boot
    use: api
    narrate: "First we start the API server."
    steps:
      - type: "npm run dev"
      - key: Enter
      - wait_for:
          stdout: /listening on :3000/
    assert:
      - process_alive: true

  - id: order
    use: web
    narrate: "A customer places an order."
    focus: "[data-test=order-form]"
    steps:
      - goto: http://localhost:3000
      - click: "[data-test=new-order]"
      - fill: { selector: "#qty", value: "3" }
      - click: "text=Submit"
      - wait_for:
          selector: ".order-confirmed"
    assert:
      - visible: ".order-confirmed"
      - no_console_errors: true

  - id: logs
    use: api
    layout:
      primary: web
      inset: { session: api, corner: bottom-right, scale: 0.4 }
    narrate: "And the server logs it."
    assert:
      - stdout_matches: /POST \/orders 201/
```

`fixtures/broken/undeclared-session.yaml`:

```yaml
autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: order
    use: wbe
    assert:
      - process_alive: true
```

`fixtures/broken/bad-regex.yaml`:

```yaml
autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
    steps:
      - wait_for:
          stdout: /listening on :30(0/
    assert:
      - process_alive: true
```

`fixtures/broken/wrong-backend.yaml`:

```yaml
autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
    steps:
      - goto: http://localhost:3000
    assert:
      - process_alive: true
```

`fixtures/broken/yaml-syntax.yaml`:

```yaml
autocast: 1
scenes:
  - id: boot
   use: api
```

`fixtures/warnings/no-assertions.yaml` — valid, but trips L004. Lives outside
`broken/` because everything in `broken/` must exit 1, and this must exit 0
unless `--strict` is passed:

```yaml
autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
    steps:
      - type: ls
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/validate/validate.test.ts`
Expected: FAIL — cannot resolve `./validate.js`.

- [ ] **Step 4: Implement the pipeline**

Create `src/validate/validate.ts`:

```ts
import type { Diagnostic } from './diagnostic.js';
import { lint } from './lint.js';
import { parseSource } from './parse.js';
import { checkSchema } from './schema-check.js';

/**
 * Full static validation. Lint only runs when the schema stage produced a
 * script — linting a shape we could not parse would produce noise, not
 * information.
 */
export function validateText(text: string): Diagnostic[] {
  const parsed = parseSource(text);
  const { diagnostics, script } = checkSchema(parsed);
  if (script === null) return diagnostics;
  return [...diagnostics, ...lint(script, parsed)];
}
```

- [ ] **Step 5: Run pipeline tests to verify they pass**

Run: `npx vitest run src/validate/validate.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Write the failing command test**

Create `src/cli/validate-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('autocast validate', () => {
  it('exits 0 on the flagship fixture', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/mixed/demo.yaml'], c.io);
    expect(code).toBe(0);
  });

  it('exits 1 and names the file, line and reason on a broken fixture', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/broken/undeclared-session.yaml'], c.io);
    expect(code).toBe(1);
    expect(c.out()).toContain('fixtures/broken/undeclared-session.yaml:9');
    expect(c.out()).toContain('L001');
    expect(c.out()).toContain('not declared');
  });

  it('exits 2 when the file does not exist', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/nope.yaml'], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('cannot read');
  });

  it('exits 2 when no file is given', async () => {
    const c = captureIO();
    const code = await runCli(['validate'], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('expects a file');
  });

  it('exits 0 on a warnings-only file by default', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/warnings/no-assertions.yaml'], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain('L004');
  });

  it('exits 1 on the same warnings-only file when --strict is passed', async () => {
    const c = captureIO();
    const code = await runCli(['validate', '--strict', 'fixtures/warnings/no-assertions.yaml'], c.io);
    expect(code).toBe(1);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/cli/validate-command.test.ts`
Expected: FAIL — exit code 2, `unknown command "validate"`.

- [ ] **Step 8: Implement the command and register it**

Create `src/cli/validate-command.ts`:

```ts
import { readFileSync } from 'node:fs';
import { formatDiagnostics, hasErrors } from '../validate/diagnostic.js';
import { validateText } from '../validate/validate.js';
import type { CliIO } from './run.js';

export async function validateCommand(argv: string[], io: CliIO): Promise<number> {
  const strict = argv.includes('--strict');
  const file = argv.find((a) => !a.startsWith('--'));

  if (file === undefined) {
    io.err('autocast validate: expects a file\n\nUsage: autocast validate [--strict] <file>');
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    io.err(
      `autocast validate: cannot read ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }

  const diagnostics = validateText(text);
  io.out(formatDiagnostics(file, diagnostics));

  if (hasErrors(diagnostics)) return 1;
  if (strict && diagnostics.length > 0) return 1;
  return 0;
}
```

Modify `src/cli/run.ts` — add the import at the top:

```ts
import { validateCommand } from './validate-command.js';
```

and insert this block immediately after the `const command = argv[0];` / `if (command === undefined)` block, before the unknown-command fallthrough:

```ts
  if (command === 'validate') {
    return validateCommand(argv.slice(1), io);
  }
```

- [ ] **Step 9: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 10: Commit**

```bash
git add src/validate/validate.ts src/validate/validate.test.ts src/cli/validate-command.ts src/cli/validate-command.test.ts src/cli/run.ts fixtures/
git commit -m "feat: autocast validate command with fixtures"
```

---

### Task 8: The doctor command

**Files:**
- Create: `src/doctor/checks.ts`
- Create: `src/doctor/ffmpeg.ts`
- Create: `src/cli/doctor-command.ts`
- Modify: `src/cli/run.ts`
- Test: `src/doctor/ffmpeg.test.ts`
- Test: `src/cli/doctor-command.test.ts`

**Interfaces:**
- Consumes: `CliIO` (1)
- Produces:
  - `type CheckStatus = 'ok' | 'warn' | 'fail'`
  - `interface CheckResult { name: string; status: CheckStatus; detail: string; hint?: string }`
  - `interface Check { name: string; run(): Promise<CheckResult> }`
  - `function parseFfmpegVersion(stdout: string): { version: string | null; libs: ReadonlySet<string> }`
  - `const CHECKS: Check[]` — Phase 0 registers ffmpeg, libx264, librubberband and output-directory writability. **Later phases push `node-pty` and Playwright checks onto this array; do not add them now, because reporting a dependency the installed feature set does not need is not truthful.**
  - `async function doctorCommand(argv: string[], io: CliIO): Promise<number>`

- [ ] **Step 1: Write the failing ffmpeg-parsing test**

Create `src/doctor/ffmpeg.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseFfmpegVersion } from './ffmpeg.js';

const REAL = `ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers
built with gcc 14.2.0 (Rev1, Built by MSYS2 project)
configuration: --enable-gpl --enable-libx264 --enable-libx265 --enable-librubberband --enable-libass
`;

describe('parseFfmpegVersion', () => {
  it('extracts the version number', () => {
    expect(parseFfmpegVersion(REAL).version).toBe('7.1.1');
  });

  it('detects enabled libraries', () => {
    const { libs } = parseFfmpegVersion(REAL);
    expect(libs.has('libx264')).toBe(true);
    expect(libs.has('librubberband')).toBe(true);
    expect(libs.has('libvpx')).toBe(false);
  });

  it('returns a null version for unrecognisable output', () => {
    expect(parseFfmpegVersion('command not found').version).toBeNull();
  });

  it('returns no libs when there is no configuration line', () => {
    expect(parseFfmpegVersion('ffmpeg version 6.0').libs.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/doctor/ffmpeg.test.ts`
Expected: FAIL — cannot resolve `./ffmpeg.js`.

- [ ] **Step 3: Implement ffmpeg detection**

Create `src/doctor/ffmpeg.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FfmpegInfo {
  version: string | null;
  libs: ReadonlySet<string>;
}

let probeCache: Promise<FfmpegInfo | null> | undefined;

export function parseFfmpegVersion(stdout: string): FfmpegInfo {
  const version = /^ffmpeg version (\d+\.\d+(?:\.\d+)?)/m.exec(stdout)?.[1] ?? null;
  const config = /^\s*configuration:(.*)$/m.exec(stdout)?.[1] ?? '';
  const libs = new Set<string>();
  for (const m of config.matchAll(/--enable-(lib[a-z0-9]+)/g)) {
    libs.add(m[1]!);
  }
  return { version, libs };
}

/**
 * Returns null when ffmpeg is not on PATH or does not run.
 *
 * Memoized: several checks ask about the same ffmpeg build, and spawning
 * the binary once per check would be three processes for one answer.
 */
export function probeFfmpeg(): Promise<FfmpegInfo | null> {
  probeCache ??= (async () => {
    try {
      const { stdout } = await run('ffmpeg', ['-version'], { windowsHide: true });
      const info = parseFfmpegVersion(stdout);
      return info.version === null ? null : info;
    } catch {
      return null;
    }
  })();
  return probeCache;
}

/** Test-only: drop the memo so a test can simulate a different machine. */
export function resetFfmpegProbe(): void {
  probeCache = undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/doctor/ffmpeg.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Implement the check registry**

Create `src/doctor/checks.ts`:

```ts
import { access, constants } from 'node:fs/promises';
import { probeFfmpeg } from './ffmpeg.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Multi-line, copy-pasteable remediation. Present when status is not 'ok'. */
  hint?: string;
}

export interface Check {
  name: string;
  run(): Promise<CheckResult>;
}

const FFMPEG_INSTALL = [
  '    autocast needs ffmpeg to encode video.',
  '    Windows:  winget install Gyan.FFmpeg',
  '    macOS:    brew install ffmpeg',
  '    Linux:    sudo apt install ffmpeg   (or your distro equivalent)',
].join('\n');

const ffmpegCheck: Check = {
  name: 'ffmpeg',
  async run() {
    const info = await probeFfmpeg();
    if (info === null) {
      return { name: 'ffmpeg', status: 'fail', detail: 'not found on PATH', hint: FFMPEG_INSTALL };
    }
    return { name: 'ffmpeg', status: 'ok', detail: info.version ?? 'unknown version' };
  },
};

const x264Check: Check = {
  name: 'libx264',
  async run() {
    const info = await probeFfmpeg();
    if (info === null) {
      return { name: 'libx264', status: 'fail', detail: 'ffmpeg not available', hint: FFMPEG_INSTALL };
    }
    if (!info.libs.has('libx264')) {
      return {
        name: 'libx264',
        status: 'fail',
        detail: 'ffmpeg was built without libx264',
        hint: '    autocast encodes H.264. Install a full ffmpeg build:\n' + FFMPEG_INSTALL,
      };
    }
    return { name: 'libx264', status: 'ok', detail: 'enabled' };
  },
};

const rubberbandCheck: Check = {
  name: 'librubberband',
  async run() {
    const info = await probeFfmpeg();
    if (info === null || !info.libs.has('librubberband')) {
      return {
        name: 'librubberband',
        status: 'warn',
        detail: 'not available',
        hint: '    Narration time-stretching will be unavailable (spec §7.1 lever 3).\n' +
              '    Silent demos are unaffected.',
      };
    }
    return { name: 'librubberband', status: 'ok', detail: 'enabled' };
  },
};

const cwdWritableCheck: Check = {
  name: 'cwd writable',
  async run() {
    try {
      await access(process.cwd(), constants.W_OK);
      return { name: 'cwd writable', status: 'ok', detail: process.cwd() };
    } catch {
      return {
        name: 'cwd writable',
        status: 'fail',
        detail: `cannot write to ${process.cwd()}`,
        hint: '    autocast writes intermediates to .autocast/ in the working directory.',
      };
    }
  },
};

/**
 * Phase 0 registers only what Phase 0 needs. Phase 1 adds a node-pty
 * check and Phase 2 adds Playwright chromium — reporting a dependency
 * the installed feature set does not use would not be truthful.
 */
export const CHECKS: Check[] = [ffmpegCheck, x264Check, rubberbandCheck, cwdWritableCheck];

export async function runChecks(checks: readonly Check[] = CHECKS): Promise<CheckResult[]> {
  return Promise.all(checks.map((c) => c.run()));
}
```

- [ ] **Step 6: Write the failing command test**

Create `src/cli/doctor-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';
import { formatCheckResults } from './doctor-command.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('formatCheckResults', () => {
  it('marks passing checks and reports success', () => {
    const text = formatCheckResults([{ name: 'ffmpeg', status: 'ok', detail: '7.1.1' }]);
    expect(text).toContain('ffmpeg');
    expect(text).toContain('7.1.1');
    expect(text).toContain('all checks passed');
  });

  it('prints the hint for a failing check', () => {
    const text = formatCheckResults([
      { name: 'ffmpeg', status: 'fail', detail: 'not found on PATH', hint: '    brew install ffmpeg' },
    ]);
    expect(text).toContain('not found on PATH');
    expect(text).toContain('brew install ffmpeg');
  });

  it('distinguishes a warning from a failure', () => {
    const text = formatCheckResults([
      { name: 'librubberband', status: 'warn', detail: 'not available', hint: '    ok for silent' },
    ]);
    expect(text).toContain('1 warning');
    expect(text).not.toContain('1 failed');
  });
});

describe('autocast doctor', () => {
  it('runs and returns 0 or 1 without throwing', async () => {
    const c = captureIO();
    const code = await runCli(['doctor'], c.io);
    expect([0, 1]).toContain(code);
    expect(c.out()).toContain('ffmpeg');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/cli/doctor-command.test.ts`
Expected: FAIL — cannot resolve `./doctor-command.js`.

- [ ] **Step 8: Implement the command and register it**

Create `src/cli/doctor-command.ts`:

```ts
import { runChecks, type CheckResult } from '../doctor/checks.js';
import type { CliIO } from './run.js';

const MARK: Record<CheckResult['status'], string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };

export function formatCheckResults(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length), 0);
  const lines: string[] = ['autocast doctor', ''];

  for (const r of results) {
    lines.push(`  ${MARK[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.hint !== undefined && r.status !== 'ok') {
      lines.push('', r.hint, '');
    }
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  lines.push('');
  if (failed > 0) {
    lines.push(`${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}`);
  } else if (warned > 0) {
    lines.push(`all required checks passed, ${warned} warning${warned === 1 ? '' : 's'}`);
  } else {
    lines.push('all checks passed');
  }

  return lines.join('\n');
}

export async function doctorCommand(_argv: string[], io: CliIO): Promise<number> {
  const results = await runChecks();
  io.out(formatCheckResults(results));
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
```

Modify `src/cli/run.ts` — add the import:

```ts
import { doctorCommand } from './doctor-command.js';
```

and add the dispatch alongside `validate`:

```ts
  if (command === 'doctor') {
    return doctorCommand(argv.slice(1), io);
  }
```

- [ ] **Step 9: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 10: Verify by hand on this machine**

Run: `npx tsx src/cli/index.ts doctor` (or `npm run build && node dist/cli/index.js doctor`)
Expected: ffmpeg, libx264 and librubberband all report OK on a machine with a full ffmpeg build. Confirm the reported version matches `ffmpeg -version`.

- [ ] **Step 11: Commit**

```bash
git add src/doctor/ src/cli/doctor-command.ts src/cli/doctor-command.test.ts src/cli/run.ts
git commit -m "feat: autocast doctor with per-platform install hints"
```

---

### Task 9: The schema command and phase acceptance tests

**Files:**
- Create: `src/cli/schema-command.ts`
- Modify: `src/cli/run.ts`
- Test: `src/cli/schema-command.test.ts`
- Test: `src/cli/acceptance.test.ts`

**Interfaces:**
- Consumes: `DemoScript` (2), `runCli`/`CliIO` (1)
- Produces: `async function schemaCommand(argv: string[], io: CliIO): Promise<number>` — prints the JSON Schema generated from the Zod schema to stdout.

- [ ] **Step 1: Write the failing schema-command test**

Create `src/cli/schema-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: () => {} };
  return { io, out: () => out.join('\n') };
}

describe('autocast schema', () => {
  it('prints valid JSON', async () => {
    const c = captureIO();
    const code = await runCli(['schema'], c.io);
    expect(code).toBe(0);
    expect(() => JSON.parse(c.out())).not.toThrow();
  });

  it('describes the demo script shape', async () => {
    const c = captureIO();
    await runCli(['schema'], c.io);
    const schema = JSON.parse(c.out()) as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['autocast', 'output', 'sessions', 'scenes']),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/schema-command.test.ts`
Expected: FAIL — exit code 2, `unknown command "schema"`.

- [ ] **Step 3: Implement the schema command and register it**

Create `src/cli/schema-command.ts`:

```ts
import { z } from 'zod';
import { DemoScript } from '../schema/demo.js';
import type { CliIO } from './run.js';

export async function schemaCommand(_argv: string[], io: CliIO): Promise<number> {
  const schema = z.toJSONSchema(DemoScript, { io: 'input' });
  io.out(JSON.stringify(schema, null, 2));
  return 0;
}
```

> If `z.toJSONSchema` is unavailable in the installed Zod version, that means Zod v3 was installed rather than v4 — fix the dependency rather than hand-writing a second schema. The whole point of generating it is that the Zod schema stays the single source of truth.

Modify `src/cli/run.ts` — add the import:

```ts
import { schemaCommand } from './schema-command.js';
```

and the dispatch:

```ts
  if (command === 'schema') {
    return schemaCommand(argv.slice(1), io);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/schema-command.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the phase-exit acceptance test**

Create `src/cli/acceptance.test.ts`. These encode the Phase 0 exit criteria from spec §12 verbatim:

```ts
import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('Phase 0 exit criteria', () => {
  it('doctor reports every check with a status', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    for (const name of ['ffmpeg', 'libx264', 'librubberband', 'cwd writable']) {
      expect(c.out()).toContain(name);
    }
  });

  it('doctor gives an actionable hint for anything not OK', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    const text = c.out();
    if (text.includes('FAIL') || text.includes('WARN')) {
      expect(text).toMatch(/install|unavailable|writes/i);
    }
  });

  it('validate passes the flagship fixture', async () => {
    const c = captureIO();
    expect(await runCli(['validate', 'fixtures/mixed/demo.yaml'], c.io)).toBe(0);
  });

  it('validate fails a broken fixture, naming the line and the reason', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/broken/undeclared-session.yaml'], c.io);
    expect(code).toBe(1);
    expect(c.out()).toMatch(/undeclared-session\.yaml:\d+:\d+/);
    expect(c.out()).toContain('not declared');
  });

  it('every broken fixture is rejected', async () => {
    for (const f of ['undeclared-session', 'bad-regex', 'wrong-backend', 'yaml-syntax']) {
      const c = captureIO();
      const code = await runCli(['validate', `fixtures/broken/${f}.yaml`], c.io);
      expect(code, `fixtures/broken/${f}.yaml should fail`).toBe(1);
    }
  });

  it('no capture dependency is present in this phase', async () => {
    const pkg = await import('node:fs').then((fs) =>
      JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
        dependencies: Record<string, string>;
      },
    );
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['yaml', 'zod']);
  });
});
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS — every suite green.

Then run: `npm run typecheck`
Expected: no errors.

Then run: `npm run build`
Expected: `dist/` is produced with no errors.

- [ ] **Step 7: Verify the exit criteria by hand**

```bash
node dist/cli/index.js doctor
node dist/cli/index.js validate fixtures/mixed/demo.yaml   # expect exit 0
node dist/cli/index.js validate fixtures/broken/undeclared-session.yaml   # expect exit 1
node dist/cli/index.js schema
```

Confirm the doctor output names real paths and versions, and that the broken fixture's message names the line and says which session was not declared.

- [ ] **Step 8: Commit**

```bash
git add src/cli/schema-command.ts src/cli/schema-command.test.ts src/cli/acceptance.test.ts src/cli/run.ts
git commit -m "feat: autocast schema command and phase 0 acceptance tests"
```

---

## Phase 0 Definition of Done

- `npx vitest run` — all green.
- `npm run typecheck` — clean.
- `npm run build` — produces `dist/`.
- `autocast doctor` truthfully reports ffmpeg, libx264, librubberband and cwd writability, with copy-pasteable install commands for anything missing.
- `autocast validate fixtures/mixed/demo.yaml` exits 0.
- Each fixture under `fixtures/broken/` exits 1 with a message naming the file, line, column and reason.
- `fixtures/warnings/no-assertions.yaml` exits 0 normally and 1 under `--strict`.
- `autocast schema` emits JSON Schema generated from the Zod schema.
- Runtime dependencies are exactly `yaml` and `zod`.
- No capture, encoding, browser or PTY code exists in the repo.
