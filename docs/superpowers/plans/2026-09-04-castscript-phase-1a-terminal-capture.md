# castscript Phase 1a — Terminal capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a real terminal session from a validated demo script and capture it as a replayable event log, with assertions — no rendering, no video.

**Architecture:** A `TerminalSession` wraps a `node-pty` process and feeds every byte into an `@xterm/headless` terminal. The PTY byte stream plus timestamps is written out as an asciicast-v2 log (the replayable artifact of spec §4.2); the xterm buffer supplies rendered text for `wait_for` and assertions, so ConPTY's escape-sequence preamble never leaks into a user-visible match. Process teardown kills by PID tree, never via node-pty's `.kill()`.

**Tech Stack:** `node-pty` 1.1.0 (ConPTY on Windows, forkpty elsewhere), `@xterm/headless` 6.0.0. Existing: TypeScript 5.9, Node 20+, vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-04-castscript-design.md` — especially §4.1, §4.2, §4.6, §6 and §6.1.

## Global Constraints

- **Node 20+**, ESM, `"type": "module"`. Windows, macOS and Linux all first-class.
- **New runtime dependencies in this plan: `node-pty` and `@xterm/headless` only.** No canvas, no ffmpeg calls — those are Phase 1b.
- **NEVER call node-pty's `.kill()` on Windows.** Spec §6.1: it spawns a console-enumeration helper that dies with `AttachConsole failed` whenever stdout is redirected, crashing a child and printing a stack trace to our stderr. Kill the process tree by PID instead.
- **A live PTY holds the Node event loop open.** Every code path that opens a session must dispose it, including on failure.
- **Matching is done against xterm-rendered text, never raw PTY bytes.** ConPTY emits a preamble (`\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H`) and OSC title sequences; matching raw bytes would be non-portable and would surprise script authors.
- **Humanized typing must be deterministic** — jitter comes from a PRNG seeded by scene id, per spec §7.2.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Timeouts in tests must be generous enough for a cold PTY spawn on Windows (~1s), but every wait must have an upper bound — no unbounded awaits.

---

### Task 1: The CLI fixture app

**Files:**
- Create: `fixtures/cli-app/cli.mjs`
- Create: `fixtures/cli-app/README.md`
- Test: `fixtures/cli-app/cli.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a dependency-free Node CLI at `fixtures/cli-app/cli.mjs` with subcommands `greet`, `build`, `watch`, `dash`, `fail`. Every later task drives this. It must never require an npm install.

- [ ] **Step 1: Write the failing test**

Create `fixtures/cli-app/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = 'fixtures/cli-app/cli.mjs';

describe('cli-app fixture', () => {
  it('greet prints a coloured greeting', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'greet', 'world']);
    expect(stdout).toContain('world');
    expect(stdout).toContain('\x1b[');
  });

  it('build redraws a progress bar with carriage returns and finishes', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'build']);
    expect(stdout).toContain('\r');
    expect(stdout).toContain('100%');
    expect(stdout).toContain('build complete');
  });

  it('fail exits non-zero and writes to stderr', async () => {
    await expect(run(process.execPath, [CLI, 'fail'])).rejects.toMatchObject({ code: 2 });
  });

  it('rejects an unknown command', async () => {
    await expect(run(process.execPath, [CLI, 'nope'])).rejects.toMatchObject({ code: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run fixtures/cli-app/cli.test.ts`
Expected: FAIL — the file does not exist. (Vitest only collects `src/**` today; add `fixtures/**/*.test.ts` to `vitest.config.ts` `include` as part of Step 3.)

- [ ] **Step 3: Write the fixture**

Update `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'fixtures/**/*.test.ts'],
  },
});
```

Create `fixtures/cli-app/cli.mjs`:

```js
#!/usr/bin/env node
// A dependency-free CLI that exercises everything a VT renderer can get
// wrong: colour, carriage-return redraw, the alternate screen, a process
// that never exits, and a non-zero exit.

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [, , command, ...args] = process.argv;

async function greet() {
  const name = args[0] ?? 'there';
  process.stdout.write(`${C.green}hello${C.reset} ${C.bold}${name}${C.reset}\n`);
  process.stdout.write(`${C.cyan}ready${C.reset}\n`);
}

async function build() {
  const width = 24;
  for (let pct = 0; pct <= 100; pct += 10) {
    const filled = Math.round((pct / 100) * width);
    const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
    process.stdout.write(`\rbuilding [${bar}] ${String(pct).padStart(3)}%`);
    await sleep(80);
  }
  process.stdout.write(`\n${C.green}build complete${C.reset}\n`);
}

async function watch() {
  process.stdout.write(`${C.yellow}watching for changes${C.reset}\n`);
  process.stdout.write('listening on :4242\n');
  // Never exits. This is the "dev server" case: the pipeline must kill it.
  setInterval(() => process.stdout.write('.'), 250);
}

async function dash() {
  process.stdout.write('\x1b[?1049h'); // enter alternate screen
  try {
    for (let tick = 0; tick < 8; tick++) {
      process.stdout.write('\x1b[2J\x1b[H'); // clear + home
      process.stdout.write('┌─ castscript dash ─┐\n');
      process.stdout.write(`│ tick ${String(tick).padStart(2)}         │\n`);
      process.stdout.write(`│ cpu  ${String(30 + tick * 5).padStart(2)}%        │\n`);
      process.stdout.write('└─────────────────┘\n');
      await sleep(120);
    }
  } finally {
    process.stdout.write('\x1b[?1049l'); // leave alternate screen
  }
  process.stdout.write('dash done\n');
}

async function fail() {
  process.stderr.write('boom: something went wrong\n');
  process.exitCode = 2;
}

const commands = { greet, build, watch, dash, fail };

const run = commands[command];
if (!run) {
  process.stderr.write(`unknown command: ${command ?? '(none)'}\n`);
  process.stderr.write(`usage: cli.mjs <${Object.keys(commands).join('|')}>\n`);
  process.exit(1);
}
await run();
```

Create `fixtures/cli-app/README.md`:

```markdown
# cli-app fixture

A dependency-free CLI used by castscript's tests. Never add npm dependencies
to it — tests must run with no install and no network.

| Command | Exercises |
|---|---|
| `greet <name>` | ANSI colour and bold |
| `build` | carriage-return progress-bar redraw |
| `watch` | a process that never exits (the dev-server case) |
| `dash` | alternate screen, full redraw, box-drawing Unicode |
| `fail` | stderr output and a non-zero exit code |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run fixtures/cli-app/cli.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify the interactive commands by hand**

```bash
node fixtures/cli-app/cli.mjs build
node fixtures/cli-app/cli.mjs dash
```

Expected: the progress bar redraws in place on one line; `dash` takes over the screen and restores it on exit.

- [ ] **Step 6: Commit**

```bash
git add fixtures/cli-app/ vitest.config.ts
git commit -m "test: dependency-free CLI fixture for terminal capture"
```

---

### Task 2: Cross-platform process-tree kill

**Files:**
- Create: `src/backends/terminal/kill-tree.ts`
- Test: `src/backends/terminal/kill-tree.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `async function killTree(pid: number): Promise<void>` — terminates the process and its descendants. Resolves even when the process is already gone.
  - `async function isProcessAlive(pid: number): Promise<boolean>`

This exists because of spec §6.1: node-pty's `.kill()` crashes a helper process on Windows whenever stdout is redirected.

- [ ] **Step 1: Write the failing test**

Create `src/backends/terminal/kill-tree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { killTree, isProcessAlive } from './kill-tree.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnForever() {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' },
  );
  return child;
}

describe('killTree', () => {
  it('reports a live process as alive', async () => {
    const child = spawnForever();
    await sleep(300);
    expect(await isProcessAlive(child.pid!)).toBe(true);
    await killTree(child.pid!);
  });

  it('kills a process that would otherwise never exit', async () => {
    const child = spawnForever();
    await sleep(300);
    await killTree(child.pid!);
    await sleep(600);
    expect(await isProcessAlive(child.pid!)).toBe(false);
  });

  it('resolves without throwing when the pid is already gone', async () => {
    const child = spawnForever();
    await sleep(300);
    await killTree(child.pid!);
    await sleep(600);
    await expect(killTree(child.pid!)).resolves.toBeUndefined();
  });

  it('reports a non-existent pid as not alive', async () => {
    expect(await isProcessAlive(0x7ffffff0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/terminal/kill-tree.test.ts`
Expected: FAIL — cannot resolve `./kill-tree.js`.

- [ ] **Step 3: Implement**

Create `src/backends/terminal/kill-tree.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const isWindows = process.platform === 'win32';

/**
 * Terminate a process and its descendants.
 *
 * On Windows this deliberately uses taskkill rather than node-pty's
 * `.kill()`. See spec section 6.1: node-pty's ConPTY kill path spawns a
 * console-enumeration helper that dies with "AttachConsole failed"
 * whenever the parent has no attached console — always true when stdout
 * is redirected, and always true in CI.
 *
 * Resolves even when the process has already exited.
 */
export async function killTree(pid: number): Promise<void> {
  if (isWindows) {
    try {
      await run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // taskkill exits non-zero when the pid is already gone.
    }
    return;
  }

  // POSIX: kill the process group if we can, then the process itself.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  if (isWindows) {
    try {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        windowsHide: true,
      });
      return stdout.includes(String(pid));
    } catch {
      return false;
    }
  }

  try {
    process.kill(pid, 0); // signal 0 tests existence without sending anything
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/terminal/kill-tree.test.ts`
Expected: PASS — 4 tests, and **no `AttachConsole failed` stack trace in the output**. Its absence is the point of this task; if it appears, something is still calling node-pty's `.kill()`.

- [ ] **Step 5: Commit**

```bash
git add src/backends/terminal/kill-tree.ts src/backends/terminal/kill-tree.test.ts
git commit -m "feat: cross-platform process-tree kill avoiding node-pty kill on Windows"
```

---

### Task 3: Seeded PRNG and typing rhythm

**Files:**
- Create: `src/backends/terminal/typing.ts`
- Test: `src/backends/terminal/typing.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `function makeRng(seed: string): () => number` — deterministic, uniform in [0, 1).
  - `interface KeyStroke { char: string; delayMs: number }`
  - `function planTyping(text: string, opts: { seed: string; baseMs: number }): KeyStroke[]` — per-character delays with Gaussian jitter (±30%) and a longer beat after `.`, `,`, `:`, `;` and space. Total is bounded and reproducible.

Spec §7.2: humanized *and* deterministic.

- [ ] **Step 1: Write the failing test**

Create `src/backends/terminal/typing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeRng, planTyping } from './typing.js';

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng('boot');
    const b = makeRng('boot');
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('differs between seeds', () => {
    expect(makeRng('boot')()).not.toBe(makeRng('order')());
  });

  it('stays within [0, 1)', () => {
    const r = makeRng('x');
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('planTyping', () => {
  const opts = { seed: 'boot', baseMs: 45 };

  it('produces one stroke per character', () => {
    const plan = planTyping('npm run dev', opts);
    expect(plan.map((k) => k.char).join('')).toBe('npm run dev');
  });

  it('is reproducible', () => {
    expect(planTyping('npm run dev', opts)).toEqual(planTyping('npm run dev', opts));
  });

  it('varies delays rather than emitting a constant rhythm', () => {
    const delays = new Set(planTyping('aaaaaaaaaa', opts).map((k) => k.delayMs));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('keeps every delay positive and within 2x the base', () => {
    for (const k of planTyping('hello, world. bye', opts)) {
      expect(k.delayMs).toBeGreaterThan(0);
      expect(k.delayMs).toBeLessThanOrEqual(opts.baseMs * 2 + 1);
    }
  });

  it('pauses longer after punctuation than after letters, on average', () => {
    // Comparing two individual strokes would be flaky: a letter jittered
    // +30% can out-wait a period jittered -30%. The beat is a distribution
    // shift, so assert on the distribution.
    const plan = planTyping('ab. cd. ef. gh. ij. kl. mn. op. qr. st.', {
      seed: 's',
      baseMs: 100,
    });
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const punct = mean(plan.filter((k) => k.char === '.').map((k) => k.delayMs));
    const letters = mean(plan.filter((k) => /[a-z]/.test(k.char)).map((k) => k.delayMs));
    expect(punct).toBeGreaterThan(letters);
  });

  it('handles an empty string', () => {
    expect(planTyping('', opts)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/terminal/typing.test.ts`
Expected: FAIL — cannot resolve `./typing.js`.

- [ ] **Step 3: Implement**

Create `src/backends/terminal/typing.ts`:

```ts
/**
 * Deterministic PRNG (mulberry32) seeded from a string. Spec section 7.2
 * wants typing that feels human but re-renders identically, so every
 * random choice has to come from a reproducible source.
 */
export function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KeyStroke {
  char: string;
  /** How long to wait AFTER emitting this character. */
  delayMs: number;
}

export interface TypingOptions {
  seed: string;
  baseMs: number;
}

/** Characters that earn a longer beat, as a real typist would pause. */
const BEAT_AFTER = new Set(['.', ',', ':', ';', '!', '?', ' ']);

/** Box-Muller, clamped, so jitter is Gaussian rather than uniform. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2, Math.min(2, n)) / 2; // roughly [-1, 1]
}

export function planTyping(text: string, opts: TypingOptions): KeyStroke[] {
  const rng = makeRng(opts.seed);
  const strokes: KeyStroke[] = [];

  for (const char of text) {
    const jitter = 1 + gaussian(rng) * 0.3; // +/-30%
    const beat = BEAT_AFTER.has(char) ? 1.6 : 1;
    const delay = Math.round(opts.baseMs * jitter * beat);
    strokes.push({ char, delayMs: Math.max(1, Math.min(delay, opts.baseMs * 2)) });
  }

  return strokes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/terminal/typing.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backends/terminal/typing.ts src/backends/terminal/typing.test.ts
git commit -m "feat: deterministic humanized typing rhythm"
```

---

### Task 4: The asciicast event log

**Files:**
- Create: `src/backends/terminal/cast.ts`
- Test: `src/backends/terminal/cast.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type CastEvent = [timeSec: number, kind: 'o', data: string]`
  - `interface CastLog { version: 2; width: number; height: number; timestamp: number; events: CastEvent[] }`
  - `class CastRecorder` with `constructor(width, height, now: () => number)`, `record(data: string): void`, `log(): CastLog`, `toJsonl(): string`
  - `function parseJsonl(text: string): CastLog`

This is the replayable artifact of spec §4.2, and asciicast-v2 compatible so recordings interoperate with the existing ecosystem.

- [ ] **Step 1: Write the failing test**

Create `src/backends/terminal/cast.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CastRecorder, parseJsonl } from './cast.js';

function fakeClock(times: number[]) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

describe('CastRecorder', () => {
  it('records events with seconds elapsed since start', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 500, 1500]));
    r.record('a');
    r.record('b');
    const log = r.log();
    expect(log.events[0]![0]).toBeCloseTo(0.5, 3);
    expect(log.events[1]![0]).toBeCloseTo(1.5, 3);
  });

  it('carries the terminal geometry', () => {
    const log = new CastRecorder(100, 28, fakeClock([0])).log();
    expect(log.width).toBe(100);
    expect(log.height).toBe(28);
    expect(log.version).toBe(2);
  });

  it('preserves escape sequences verbatim', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 10]));
    r.record('\x1b[32mgreen\x1b[0m');
    expect(r.log().events[0]![2]).toBe('\x1b[32mgreen\x1b[0m');
  });

  it('round-trips through asciicast v2 jsonl', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 100, 250]));
    r.record('one');
    r.record('\x1b[2Jtwo');
    const parsed = parseJsonl(r.toJsonl());
    expect(parsed).toEqual(r.log());
  });

  it('writes a header line then one line per event', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 100]));
    r.record('x');
    const lines = r.toJsonl().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: 2, width: 80, height: 24 });
    expect(JSON.parse(lines[1]!)[2]).toBe('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/terminal/cast.test.ts`
Expected: FAIL — cannot resolve `./cast.js`.

- [ ] **Step 3: Implement**

Create `src/backends/terminal/cast.ts`:

```ts
/** [seconds since start, "o" for output, data] — asciicast v2. */
export type CastEvent = [number, 'o', string];

export interface CastLog {
  version: 2;
  width: number;
  height: number;
  /** Unix seconds when recording began. */
  timestamp: number;
  events: CastEvent[];
}

/**
 * Accumulates the PTY byte stream with timestamps. This IS the semantic
 * log of spec section 4.2 — kilobytes of text that can be replayed to
 * frames offline at any resolution, theme or speed.
 */
export class CastRecorder {
  private readonly startedAt: number;
  private readonly events: CastEvent[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
  }

  record(data: string): void {
    const seconds = (this.now() - this.startedAt) / 1000;
    this.events.push([Number(seconds.toFixed(6)), 'o', data]);
  }

  log(): CastLog {
    return {
      version: 2,
      width: this.width,
      height: this.height,
      timestamp: Math.floor(this.startedAt / 1000),
      events: [...this.events],
    };
  }

  toJsonl(): string {
    const log = this.log();
    const header = JSON.stringify({
      version: log.version,
      width: log.width,
      height: log.height,
      timestamp: log.timestamp,
    });
    return [header, ...log.events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  }
}

export function parseJsonl(text: string): CastLog {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const [headerLine, ...eventLines] = lines;
  if (headerLine === undefined) throw new Error('empty asciicast');

  const header = JSON.parse(headerLine) as Omit<CastLog, 'events'>;
  return {
    version: 2,
    width: header.width,
    height: header.height,
    timestamp: header.timestamp,
    events: eventLines.map((l) => JSON.parse(l) as CastEvent),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/terminal/cast.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backends/terminal/cast.ts src/backends/terminal/cast.test.ts
git commit -m "feat: asciicast v2 event log recorder"
```

---

### Task 5: The terminal session

**Files:**
- Modify: `package.json` (add `node-pty`, `@xterm/headless`)
- Create: `src/backends/terminal/session.ts`
- Test: `src/backends/terminal/session.test.ts`

**Interfaces:**
- Consumes: `killTree` (Task 2), `CastRecorder`/`CastLog` (Task 4)
- Produces:
  - `interface TerminalSessionOptions { cols?: number; rows?: number; cwd?: string; env?: Record<string, string>; now?: () => number }`
  - `interface TerminalSession` with:
    - `readonly pid: number`
    - `write(data: string): void`
    - `text(): Promise<string>` — the xterm buffer including scrollback, trailing blank lines trimmed
    - `waitFor(pattern: RegExp, timeoutMs: number): Promise<boolean>`
    - `isAlive(): boolean`
    - `exitCode(): number | null`
    - `cast(): CastLog`
    - `dispose(): Promise<void>` — idempotent
  - `async function openTerminalSession(opts?: TerminalSessionOptions): Promise<TerminalSession>`

`text()` is async because xterm's `write` is callback-based; reading before the queue drains would race.

- [ ] **Step 1: Install the dependencies**

```bash
npm install node-pty@^1.1.0 @xterm/headless@^6.0.0
```

Verify they resolved from prebuilds (no compiler output):

```bash
node -e "console.log(require('node-pty/package.json').version, require('@xterm/headless/package.json').version)"
```

Expected: `1.1.0 6.0.0`

- [ ] **Step 2: Write the failing test**

Create `src/backends/terminal/session.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { openTerminalSession, type TerminalSession } from './session.js';

const CLI = 'fixtures/cli-app/cli.mjs';
const open: TerminalSession[] = [];

async function session(cols = 80, rows = 24) {
  const s = await openTerminalSession({ cols, rows });
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

describe('TerminalSession', () => {
  it('runs a command and exposes its rendered output', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet world\r`);
    expect(await s.waitFor(/hello world/, 15000)).toBe(true);
    expect(await s.text()).toContain('ready');
  }, 30000);

  it('strips ANSI escapes from the text view', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet world\r`);
    await s.waitFor(/ready/, 15000);
    expect(await s.text()).not.toContain('\x1b[');
  }, 30000);

  it('resolves a carriage-return progress bar to its final state', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} build\r`);
    expect(await s.waitFor(/build complete/, 20000)).toBe(true);
    const text = await s.text();
    expect(text).toContain('100%');
    // The bar redraws in place: intermediate percentages must not survive.
    expect(text).not.toContain('10%\n');
  }, 30000);

  it('records an asciicast with events', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet world\r`);
    await s.waitFor(/ready/, 15000);
    const cast = s.cast();
    expect(cast.version).toBe(2);
    expect(cast.width).toBe(80);
    expect(cast.events.length).toBeGreaterThan(0);
    expect(cast.events.map((e) => e[2]).join('')).toContain('hello');
  }, 30000);

  it('returns false when a pattern never appears', async () => {
    const s = await session();
    expect(await s.waitFor(/this-never-appears/, 1200)).toBe(false);
  }, 20000);

  it('kills a process that never exits, without AttachConsole noise', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} watch\r`);
    expect(await s.waitFor(/listening on :4242/, 15000)).toBe(true);
    expect(s.isAlive()).toBe(true);
    await s.dispose();
    expect(s.isAlive()).toBe(false);
  }, 30000);

  it('dispose is idempotent', async () => {
    const s = await session();
    await s.dispose();
    await expect(s.dispose()).resolves.toBeUndefined();
  }, 20000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/backends/terminal/session.test.ts`
Expected: FAIL — cannot resolve `./session.js`.

- [ ] **Step 4: Implement**

Create `src/backends/terminal/session.ts`:

```ts
import { createRequire } from 'node:module';
import { CastRecorder, type CastLog } from './cast.js';
import { killTree, isProcessAlive } from './kill-tree.js';

// node-pty and @xterm/headless are CommonJS; createRequire keeps their
// types honest without fighting ESM interop.
const require = createRequire(import.meta.url);

interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

interface XtermTerminal {
  write(data: string, cb?: () => void): void;
  rows: number;
  buffer: {
    active: {
      length: number;
      getLine(i: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
}

export interface TerminalSessionOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  now?: () => number;
}

export interface TerminalSession {
  readonly pid: number;
  write(data: string): void;
  text(): Promise<string>;
  waitFor(pattern: RegExp, timeoutMs: number): Promise<boolean>;
  isAlive(): boolean;
  exitCode(): number | null;
  cast(): CastLog;
  dispose(): Promise<void>;
}

const DEFAULT_SHELL =
  process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL ?? '/bin/bash');

export async function openTerminalSession(
  opts: TerminalSessionOptions = {},
): Promise<TerminalSession> {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const now = opts.now ?? (() => Date.now());

  const pty = require('node-pty') as {
    spawn(file: string, args: string[], o: Record<string, unknown>): PtyProcess;
  };
  const { Terminal } = require('@xterm/headless') as {
    new (o: Record<string, unknown>): XtermTerminal;
    Terminal: new (o: Record<string, unknown>) => XtermTerminal;
  };

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const recorder = new CastRecorder(cols, rows, now);

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
  });

  let exited: number | null = null;
  let disposed = false;
  /** Serialises xterm writes so text() never reads a half-applied frame. */
  let writeQueue: Promise<void> = Promise.resolve();

  proc.onData((data) => {
    recorder.record(data);
    writeQueue = writeQueue.then(
      () => new Promise<void>((resolve) => term.write(data, resolve)),
    );
  });

  proc.onExit(({ exitCode }) => {
    exited = exitCode;
  });

  const readText = async (): Promise<string> => {
    await writeQueue;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    return lines.join('\n');
  };

  const session: TerminalSession = {
    pid: proc.pid,

    write(data) {
      proc.write(data);
    },

    text: readText,

    async waitFor(pattern, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(await readText())) return true;
        if (exited !== null) {
          // Give the final flush one more look before giving up.
          return pattern.test(await readText());
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },

    isAlive() {
      return exited === null && !disposed;
    },

    exitCode() {
      return exited;
    },

    cast() {
      return recorder.log();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // NEVER proc.kill() — see spec section 6.1.
      if (await isProcessAlive(proc.pid)) {
        await killTree(proc.pid);
      }
      await writeQueue;
    },
  };

  return session;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/backends/terminal/session.test.ts`
Expected: PASS — 7 tests, and **no `AttachConsole failed` stack trace anywhere in the output**.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/backends/terminal/session.ts src/backends/terminal/session.test.ts
git commit -m "feat: terminal session over node-pty with xterm text view"
```

---

### Task 6: Step execution

**Files:**
- Create: `src/backends/terminal/steps.ts`
- Test: `src/backends/terminal/steps.test.ts`

**Interfaces:**
- Consumes: `TerminalSession` (Task 5), `planTyping` (Task 3), `compilePattern` (`src/schema/pattern.ts`)
- Produces:
  - `interface StepResult { ok: boolean; startedAt: number; endedAt: number; detail?: string }`
  - `interface StepContext { session: TerminalSession; seed: string; typingSpeedMs: number; settleMs: number; now: () => number }`
  - `async function executeStep(step: Step, ctx: StepContext): Promise<StepResult>` where `Step` is the inferred type from `src/schema/demo.ts`.

Supported keys: `type`, `key`, `wait_for` (stdout), `run`, `sleep`. Browser keys are rejected — lint L008 catches them earlier, so reaching one here is a bug and must throw rather than pass silently.

- [ ] **Step 1: Write the failing test**

Create `src/backends/terminal/steps.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { openTerminalSession, type TerminalSession } from './session.js';
import { executeStep, type StepContext } from './steps.js';

const CLI = 'fixtures/cli-app/cli.mjs';
const open: TerminalSession[] = [];

async function ctx(): Promise<StepContext> {
  const session = await openTerminalSession({ cols: 80, rows: 24 });
  open.push(session);
  return { session, seed: 'test', typingSpeedMs: 5, settleMs: 10, now: () => Date.now() };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

describe('executeStep', () => {
  it('types text without submitting it', async () => {
    const c = await ctx();
    const r = await executeStep({ type: 'echo typed-marker' }, c);
    expect(r.ok).toBe(true);
    expect(await c.session.text()).toContain('echo typed-marker');
  }, 30000);

  it('key Enter submits the typed line', async () => {
    const c = await ctx();
    await executeStep({ type: `"${process.execPath}" ${CLI} greet enter-works` }, c);
    await executeStep({ key: 'Enter' }, c);
    expect(await c.session.waitFor(/hello enter-works/, 15000)).toBe(true);
  }, 30000);

  it('wait_for resolves when stdout matches', async () => {
    const c = await ctx();
    await executeStep({ type: `"${process.execPath}" ${CLI} build` }, c);
    await executeStep({ key: 'Enter' }, c);
    const r = await executeStep({ wait_for: { stdout: '/build complete/' } }, c);
    expect(r.ok).toBe(true);
  }, 40000);

  it('wait_for fails with a useful detail when the pattern never appears', async () => {
    const c = await ctx();
    const r = await executeStep(
      { wait_for: { stdout: '/never-ever-appears/', timeout: 800 } },
      c,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('never-ever-appears');
  }, 20000);

  it('run executes a command and waits for the shell prompt to return', async () => {
    const c = await ctx();
    const r = await executeStep({ run: `"${process.execPath}" ${CLI} greet ran` }, c);
    expect(r.ok).toBe(true);
    expect(await c.session.text()).toContain('hello ran');
  }, 30000);

  it('sleep waits roughly the requested time', async () => {
    const c = await ctx();
    const r = await executeStep({ sleep: 300 }, c);
    expect(r.endedAt - r.startedAt).toBeGreaterThanOrEqual(250);
  }, 20000);

  it('throws on a browser-only step, which lint should have caught', async () => {
    const c = await ctx();
    await expect(executeStep({ goto: 'http://x' }, c)).rejects.toThrow(/browser/i);
  }, 20000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/terminal/steps.test.ts`
Expected: FAIL — cannot resolve `./steps.js`.

- [ ] **Step 3: Implement**

Create `src/backends/terminal/steps.ts`:

```ts
import { compilePattern } from '../../schema/pattern.js';
import { planTyping } from './typing.js';
import type { TerminalSession } from './session.js';

export interface StepResult {
  ok: boolean;
  startedAt: number;
  endedAt: number;
  detail?: string;
}

export interface StepContext {
  session: TerminalSession;
  /** Seeds typing jitter; use the scene id so re-renders match. */
  seed: string;
  typingSpeedMs: number;
  settleMs: number;
  now: () => number;
}

/** Names accepted by a `key:` step, mapped to the bytes a PTY expects. */
const KEYS: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Space: ' ',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  CtrlC: '\x03',
  CtrlD: '\x04',
};

const DEFAULT_WAIT_MS = 30000;

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  const value = Number(m[1]);
  return m[2] === 's' ? value * 1000 : value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A step is one object with exactly one action key; the schema guarantees it. */
type AnyStep = Record<string, unknown>;

export async function executeStep(step: AnyStep, ctx: StepContext): Promise<StepResult> {
  const startedAt = ctx.now();
  const done = (ok: boolean, detail?: string): StepResult => ({
    ok,
    startedAt,
    endedAt: ctx.now(),
    ...(detail === undefined ? {} : { detail }),
  });

  if (typeof step.type === 'string') {
    for (const stroke of planTyping(step.type, { seed: ctx.seed, baseMs: ctx.typingSpeedMs })) {
      ctx.session.write(stroke.char);
      await sleep(stroke.delayMs);
    }
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (typeof step.key === 'string') {
    const bytes = KEYS[step.key];
    if (bytes === undefined) {
      return done(false, `unknown key "${step.key}". Known keys: ${Object.keys(KEYS).join(', ')}`);
    }
    ctx.session.write(bytes);
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (step.wait_for !== undefined) {
    const w = step.wait_for as { stdout?: string; selector?: string; timeout?: number | string };
    if (w.selector !== undefined) {
      throw new Error('wait_for.selector is browser-only; lint rule L008 should have caught this');
    }
    if (w.stdout === undefined) {
      return done(false, 'wait_for on a terminal session needs a stdout pattern');
    }
    const re = compilePattern(w.stdout);
    if (re === null) return done(false, `invalid regular expression: ${w.stdout}`);

    const timeout = toMs(w.timeout, DEFAULT_WAIT_MS);
    const matched = await ctx.session.waitFor(re, timeout);
    return matched
      ? done(true)
      : done(false, `timed out after ${timeout}ms waiting for ${w.stdout} on stdout`);
  }

  if (typeof step.run === 'string') {
    const marker = `__castscript_done_${Math.random().toString(36).slice(2, 8)}__`;
    const joiner = process.platform === 'win32' ? ' & ' : ' ; ';
    ctx.session.write(`${step.run}${joiner}echo ${marker}\r`);
    const matched = await ctx.session.waitFor(new RegExp(marker), DEFAULT_WAIT_MS);
    await sleep(ctx.settleMs);
    return matched ? done(true) : done(false, `run did not complete: ${step.run}`);
  }

  if (step.sleep !== undefined) {
    await sleep(toMs(step.sleep as number | string, 0));
    return done(true);
  }

  const key = Object.keys(step)[0] ?? '(empty)';
  throw new Error(
    `step "${key}" is not supported by the terminal backend — it is browser-only. ` +
      'Lint rule L008 should have caught this before capture.',
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/terminal/steps.test.ts`
Expected: PASS — 7 tests.

> If the `run` test is flaky because the shell echoes the marker command
> itself before running it, match on the marker appearing **twice** (echo
> plus output) or write the marker with a shell-specific quoting trick.
> Do not weaken the assertion to a bare `waitFor(/./)`.

- [ ] **Step 5: Commit**

```bash
git add src/backends/terminal/steps.ts src/backends/terminal/steps.test.ts
git commit -m "feat: terminal step execution"
```

---

### Task 7: Terminal assertions

**Files:**
- Create: `src/backends/terminal/assertions.ts`
- Test: `src/backends/terminal/assertions.test.ts`

**Interfaces:**
- Consumes: `TerminalSession` (Task 5), `compilePattern`
- Produces:
  - `interface AssertResult { name: string; ok: boolean; detail?: string }`
  - `async function evaluateAssertion(assertion: Record<string, unknown>, session: TerminalSession): Promise<AssertResult>`

Supports `process_alive`, `exit_code`, `stdout_contains`, `stdout_matches`, `stderr_empty`. Browser assertions throw (lint L009 catches them earlier).

Note on `stderr_empty`: a PTY merges stdout and stderr onto one stream by design, so this cannot be answered from a PTY session. It must return `ok: false` with an explicit explanation rather than silently passing — a false pass is exactly the failure mode spec §8 exists to prevent.

- [ ] **Step 1: Write the failing test**

Create `src/backends/terminal/assertions.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { openTerminalSession, type TerminalSession } from './session.js';
import { evaluateAssertion } from './assertions.js';

const CLI = 'fixtures/cli-app/cli.mjs';
const open: TerminalSession[] = [];

async function session() {
  const s = await openTerminalSession({ cols: 80, rows: 24 });
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

describe('evaluateAssertion', () => {
  it('stdout_contains passes when the text is present', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet asserted\r`);
    await s.waitFor(/hello asserted/, 15000);
    expect(await evaluateAssertion({ stdout_contains: 'hello asserted' }, s)).toMatchObject({
      ok: true,
    });
  }, 30000);

  it('stdout_contains fails with the tail of the output as detail', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet asserted\r`);
    await s.waitFor(/ready/, 15000);
    const r = await evaluateAssertion({ stdout_contains: 'not-in-the-output' }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('hello asserted');
  }, 30000);

  it('stdout_matches honours a regex', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} build\r`);
    await s.waitFor(/build complete/, 20000);
    expect(await evaluateAssertion({ stdout_matches: '/\\[#+-*\\] +100%/' }, s)).toMatchObject({
      ok: true,
    });
  }, 40000);

  it('process_alive is true for a live shell', async () => {
    const s = await session();
    expect(await evaluateAssertion({ process_alive: true }, s)).toMatchObject({ ok: true });
  }, 20000);

  it('process_alive: false fails while the shell is still running', async () => {
    const s = await session();
    expect(await evaluateAssertion({ process_alive: false }, s)).toMatchObject({ ok: false });
  }, 20000);

  it('stderr_empty reports honestly that a PTY cannot answer it', async () => {
    const s = await session();
    const r = await evaluateAssertion({ stderr_empty: true }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/merges stdout and stderr/i);
  }, 20000);

  it('throws on a browser-only assertion', async () => {
    const s = await session();
    await expect(evaluateAssertion({ visible: '.x' }, s)).rejects.toThrow(/browser/i);
  }, 20000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/terminal/assertions.test.ts`
Expected: FAIL — cannot resolve `./assertions.js`.

- [ ] **Step 3: Implement**

Create `src/backends/terminal/assertions.ts`:

```ts
import { compilePattern } from '../../schema/pattern.js';
import type { TerminalSession } from './session.js';

export interface AssertResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Last few non-empty lines, so a failure says what was actually on screen. */
function tail(text: string, lines = 5): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join('\n');
}

export async function evaluateAssertion(
  assertion: Record<string, unknown>,
  session: TerminalSession,
): Promise<AssertResult> {
  const name = Object.keys(assertion)[0] ?? '(empty)';
  const fail = (detail: string): AssertResult => ({ name, ok: false, detail });
  const pass = (): AssertResult => ({ name, ok: true });

  if (assertion.process_alive !== undefined) {
    const want = assertion.process_alive === true;
    const got = session.isAlive();
    return got === want ? pass() : fail(`expected process_alive=${want}, but it was ${got}`);
  }

  if (assertion.exit_code !== undefined) {
    const want = assertion.exit_code as number;
    const got = session.exitCode();
    if (got === null) return fail(`expected exit code ${want}, but the process is still running`);
    return got === want ? pass() : fail(`expected exit code ${want}, got ${got}`);
  }

  if (typeof assertion.stdout_contains === 'string') {
    const needle = assertion.stdout_contains;
    const text = await session.text();
    return text.includes(needle)
      ? pass()
      : fail(`"${needle}" not found. Last lines of output:\n${tail(text)}`);
  }

  if (typeof assertion.stdout_matches === 'string') {
    const source = assertion.stdout_matches;
    const re = compilePattern(source);
    if (re === null) return fail(`invalid regular expression: ${source}`);
    const text = await session.text();
    return re.test(text)
      ? pass()
      : fail(`${source} did not match. Last lines of output:\n${tail(text)}`);
  }

  if (assertion.stderr_empty !== undefined) {
    // A PTY is a single stream by design: the child's stdout and stderr are
    // both attached to the same terminal, so there is no separate stderr to
    // inspect. Passing here would be a false green, which spec section 8
    // exists to prevent.
    return fail(
      'stderr_empty cannot be evaluated on a terminal session: a PTY merges stdout and stderr ' +
        'onto one stream. Assert on stdout_matches instead, or run the command with `run:` and ' +
        'assert on exit_code.',
    );
  }

  throw new Error(
    `assertion "${name}" is browser-only and cannot run against a terminal session. ` +
      'Lint rule L009 should have caught this before capture.',
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/terminal/assertions.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backends/terminal/assertions.ts src/backends/terminal/assertions.test.ts
git commit -m "feat: terminal assertions, with stderr_empty failing honestly"
```

---

### Task 8: Doctor learns about node-pty

**Files:**
- Modify: `src/doctor/checks.ts`
- Modify: `src/doctor/checks.test.ts`

**Interfaces:**
- Consumes: `Check`, `CheckResult`, `CHECKS` (Phase 0)
- Produces: a `node-pty` entry appended to `CHECKS`, verifying the native module actually loads rather than merely being present in `package.json`.

Spec §8 preflight: fail loudly and early, with actionable instructions.

- [ ] **Step 1: Write the failing test**

Append to `src/doctor/checks.test.ts`:

```ts
describe('node-pty check', () => {
  it('is registered in the default check list', () => {
    expect(CHECKS.map((c) => c.name)).toContain('node-pty');
  });

  it('reports ok when the native module loads', async () => {
    const check = CHECKS.find((c) => c.name === 'node-pty')!;
    const r = await check.run();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/\d+\.\d+\.\d+/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/doctor/checks.test.ts`
Expected: FAIL — `node-pty` is not in `CHECKS`.

- [ ] **Step 3: Implement**

In `src/doctor/checks.ts`, add near the top:

```ts
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
```

Add the check before the `CHECKS` export:

```ts
const nodePtyCheck: Check = {
  name: 'node-pty',
  async run() {
    try {
      const version = (requireCjs('node-pty/package.json') as { version: string }).version;
      requireCjs('node-pty'); // loading the native binding is the real test
      return { name: 'node-pty', status: 'ok', detail: version };
    } catch (error) {
      return {
        name: 'node-pty',
        status: 'fail',
        detail: `native module failed to load: ${
          error instanceof Error ? error.message : String(error)
        }`,
        hint: [
          '    node-pty ships prebuilt binaries for common platforms.',
          '    If yours is not covered, it must be built from source:',
          '    Windows:  npm install --global windows-build-tools   (or install Visual Studio Build Tools)',
          '    macOS:    xcode-select --install',
          '    Linux:    sudo apt install build-essential python3',
          '    Then:     npm rebuild node-pty',
        ].join('\n'),
      };
    }
  },
};
```

Update the export and its comment:

```ts
/**
 * Each phase registers only what it needs. Phase 2 adds Playwright
 * chromium — reporting a dependency the installed feature set does not
 * use would not be truthful.
 */
export const CHECKS: Check[] = [
  ffmpegCheck,
  x264Check,
  rubberbandCheck,
  nodePtyCheck,
  cwdWritableCheck,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/doctor/`
Expected: PASS.

Then check the Phase 0 acceptance test still holds:

Run: `npx vitest run src/cli/acceptance.test.ts`
Expected: PASS — it asserts the presence of named checks, not the absence of others. It also asserts `dependencies` are exactly `yaml` and `zod`; **update that assertion** to `['@xterm/headless', 'node-pty', 'yaml', 'zod']`, since Phase 1a legitimately adds two.

- [ ] **Step 5: Verify by hand**

Run: `npm run build && node dist/cli/index.js doctor`
Expected: a `node-pty` row reporting `1.1.0`.

- [ ] **Step 6: Commit**

```bash
git add src/doctor/checks.ts src/doctor/checks.test.ts src/cli/acceptance.test.ts
git commit -m "feat: doctor verifies the node-pty native module loads"
```

---

### Task 9: The terminal capture driver

**Files:**
- Create: `src/driver/capture.ts`
- Test: `src/driver/capture.test.ts`
- Create: `fixtures/terminal/demo.yaml`

**Interfaces:**
- Consumes: everything above, plus `DemoScript` (`src/schema/demo.js`) and `validateText` (`src/validate/validate.js`)
- Produces:
  - `interface SceneCapture { id: string; steps: StepResult[]; assertions: AssertResult[]; ok: boolean; startedAt: number; endedAt: number }`
  - `interface CaptureArtifact { scenes: SceneCapture[]; casts: Record<string, CastLog>; ok: boolean }`
  - `async function captureTerminalDemo(script: DemoScript, opts?: { now?: () => number }): Promise<CaptureArtifact>`

Sessions are opened once and shared across scenes (spec §4.6) and disposed in reverse declaration order inside a `finally`, so a thrown step cannot orphan a dev server.

This task handles terminal sessions only; a script containing a browser session must throw a clear "not until Phase 2" error rather than silently skipping scenes.

- [ ] **Step 1: Write the fixture**

Create `fixtures/terminal/demo.yaml`:

```yaml
castscript: 1
output:
  path: docs/terminal-demo.mp4

defaults:
  typing_speed: 20ms
  settle: 150ms

sessions:
  cli:
    backend: terminal
    cols: 90
    rows: 24

scenes:
  - id: greet
    use: cli
    narrate: "First, a greeting."
    steps:
      - type: "node fixtures/cli-app/cli.mjs greet castscript"
      - key: Enter
      - wait_for:
          stdout: /ready/
    assert:
      - stdout_contains: "hello castscript"

  - id: build
    use: cli
    narrate: "Now a build, with a progress bar that redraws in place."
    steps:
      - type: "node fixtures/cli-app/cli.mjs build"
      - key: Enter
      - wait_for:
          stdout: /build complete/
    assert:
      - stdout_matches: /100%/
      - process_alive: true
```

- [ ] **Step 2: Write the failing test**

Create `src/driver/capture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { captureTerminalDemo } from './capture.js';

function load(path: string) {
  const { script, diagnostics } = checkSchema(parseSource(readFileSync(path, 'utf8')));
  if (!script) throw new Error(`fixture invalid: ${JSON.stringify(diagnostics)}`);
  return script;
}

describe('captureTerminalDemo', () => {
  it('captures every scene and reports success', async () => {
    const result = await captureTerminalDemo(load('fixtures/terminal/demo.yaml'));
    expect(result.scenes.map((s) => s.id)).toEqual(['greet', 'build']);
    expect(result.ok, JSON.stringify(result.scenes, null, 2)).toBe(true);
  }, 90000);

  it('produces one asciicast per session, containing real output', async () => {
    const result = await captureTerminalDemo(load('fixtures/terminal/demo.yaml'));
    const cast = result.casts.cli;
    expect(cast).toBeDefined();
    expect(cast!.width).toBe(90);
    expect(cast!.events.length).toBeGreaterThan(0);
    expect(cast!.events.map((e) => e[2]).join('')).toContain('hello castscript');
  }, 90000);

  it('shares one session across scenes rather than respawning', async () => {
    const result = await captureTerminalDemo(load('fixtures/terminal/demo.yaml'));
    expect(Object.keys(result.casts)).toEqual(['cli']);
  }, 90000);

  it('reports a failing assertion instead of throwing', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'this-text-is-never-printed' }];
    const result = await captureTerminalDemo(script);
    expect(result.ok).toBe(false);
    const scene = result.scenes.find((s) => s.id === 'greet')!;
    expect(scene.ok).toBe(false);
    expect(scene.assertions[0]!.detail).toContain('not found');
  }, 90000);

  it('rejects a browser session with a clear phase message', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.sessions.web = { backend: 'browser' };
    await expect(captureTerminalDemo(script)).rejects.toThrow(/Phase 2/i);
  }, 30000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/driver/capture.test.ts`
Expected: FAIL — cannot resolve `./capture.js`.

- [ ] **Step 4: Implement**

Create `src/driver/capture.ts`:

```ts
import type { DemoScript } from '../schema/demo.js';
import { evaluateAssertion, type AssertResult } from '../backends/terminal/assertions.js';
import type { CastLog } from '../backends/terminal/cast.js';
import { openTerminalSession, type TerminalSession } from '../backends/terminal/session.js';
import { executeStep, type StepResult } from '../backends/terminal/steps.js';

export interface SceneCapture {
  id: string;
  steps: StepResult[];
  assertions: AssertResult[];
  ok: boolean;
  startedAt: number;
  endedAt: number;
}

export interface CaptureArtifact {
  scenes: SceneCapture[];
  casts: Record<string, CastLog>;
  ok: boolean;
}

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

export async function captureTerminalDemo(
  script: DemoScript,
  opts: { now?: () => number } = {},
): Promise<CaptureArtifact> {
  const now = opts.now ?? (() => Date.now());

  for (const [id, session] of Object.entries(script.sessions)) {
    if (session.backend !== 'terminal') {
      throw new Error(
        `session "${id}" uses the ${session.backend} backend, which arrives in Phase 2. ` +
          'Phase 1 captures terminal sessions only.',
      );
    }
  }

  const typingSpeedMs = toMs(script.defaults?.typing_speed, 45);
  const settleMs = toMs(script.defaults?.settle, 400);

  // Insertion order is declaration order; teardown reverses it (spec 4.6).
  const sessions = new Map<string, TerminalSession>();
  const casts: Record<string, CastLog> = {};
  const scenes: SceneCapture[] = [];

  try {
    for (const [id, config] of Object.entries(script.sessions)) {
      if (config.backend !== 'terminal') continue;
      sessions.set(
        id,
        await openTerminalSession({
          cols: config.cols ?? 80,
          rows: config.rows ?? 24,
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          ...(config.env === undefined ? {} : { env: config.env }),
          now,
        }),
      );
    }

    for (const scene of script.scenes) {
      const session = sessions.get(scene.use);
      if (!session) throw new Error(`scene "${scene.id}" uses unknown session "${scene.use}"`);

      const startedAt = now();
      const steps: StepResult[] = [];
      const assertions: AssertResult[] = [];

      for (const step of scene.steps ?? []) {
        const result = await executeStep(step as Record<string, unknown>, {
          session,
          seed: scene.id,
          typingSpeedMs,
          settleMs,
          now,
        });
        steps.push(result);
        if (!result.ok) break; // a failed step invalidates everything after it
      }

      for (const assertion of scene.assert ?? []) {
        assertions.push(await evaluateAssertion(assertion as Record<string, unknown>, session));
      }

      scenes.push({
        id: scene.id,
        steps,
        assertions,
        ok: steps.every((s) => s.ok) && assertions.every((a) => a.ok),
        startedAt,
        endedAt: now(),
      });
    }

    for (const [id, session] of sessions) casts[id] = session.cast();
    return { scenes, casts, ok: scenes.every((s) => s.ok) };
  } finally {
    // Reverse declaration order, and never let one failure strand another.
    for (const [id, session] of [...sessions].reverse()) {
      casts[id] ??= session.cast();
      await session.dispose().catch(() => undefined);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/driver/capture.test.ts`
Expected: PASS — 5 tests, no orphaned node processes afterwards.

- [ ] **Step 6: Run the whole suite and typecheck**

```bash
npx vitest run
npm run typecheck
npm run build
```

Expected: all green, no `AttachConsole failed` anywhere in the output.

- [ ] **Step 7: Verify no processes are orphaned**

On Windows, before and after running the suite:

```bash
node -e "const {execSync}=require('child_process');console.log(execSync('tasklist /FI \"IMAGENAME eq node.exe\" /NH').toString().split('\n').filter(Boolean).length)"
```

Expected: the count returns to its pre-run value within a few seconds. A rising count means `dispose()` is not being reached.

- [ ] **Step 8: Commit**

```bash
git add src/driver/capture.ts src/driver/capture.test.ts fixtures/terminal/
git commit -m "feat: terminal capture driver with session lifecycle management"
```

---

## Phase 1a Definition of Done

- `npx vitest run` — all green, and **no `AttachConsole failed` stack trace in the output**.
- `npm run typecheck` and `npm run build` — clean.
- `node dist/cli/index.js doctor` reports a `node-pty` row.
- `captureTerminalDemo` drives `fixtures/terminal/demo.yaml` end to end: two scenes, one shared session, all assertions green, an asciicast containing `hello castscript`.
- A deliberately broken assertion produces `ok: false` with a useful `detail`, rather than throwing.
- No orphaned `node.exe` processes after the suite.
- Runtime dependencies: `yaml`, `zod`, `node-pty`, `@xterm/headless`. No canvas, no ffmpeg invocation.

**Not in this plan (Phase 1b):** VT-buffer-to-frames rendering, the bundled font, the ffmpeg encoder, the `render` command, and the mp4 that is Phase 1's user-facing exit criterion.
