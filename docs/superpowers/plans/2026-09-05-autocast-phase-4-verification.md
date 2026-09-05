# autocast Phase 4 — Verification hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for autocast to hand back a plausible-looking video of a broken demo.

**Architecture:** A failing scene aborts the run before anything is encoded, so no misleading artifact is ever written. A heuristic pass catches failures nobody predicted, using the character grid and DOM text we already own rather than any vision model. The report splits into a deterministic core that CI compares and a measured annex that varies run to run. On failure a contact sheet is written to disk and its path printed — never opened.

**Tech Stack:** No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-autocast-design.md` — especially §3 constraint 2, §8, §10 and §12.

## Measured baseline (2026-09-05)

Rendering the flagship with one selector broken today produces:

```
FAILED — 2 of 3 scenes
1386 frames, 46.19s      <- a 46 second video of a broken demo, written to disk
real 1m2.987s            <- 63 seconds to report the failure
```

Three defects: the video is encoded despite a known failure, the run takes a
minute to say so, and `logs` fails only because `order` did — cascading noise
that buries the real cause.

## Global Constraints

- **Node 20+**, ESM. All three platforms. **No new runtime dependencies.**
- **Never encode a video for a run with a failed assertion.** Spec §8's
  `on_assert_fail: abort` is the documented default and is currently ignored.
- **Never leave a stale video at the output path after a failed run.** A
  previous successful render's mp4 sitting next to a failure report is exactly
  the misleading artifact this phase exists to prevent.
- **No OCR, no vision model, no LLM in the heuristics.** The terminal's
  character grid and the browser's DOM text are already available and exact.
- **Frames never auto-enter agent context** (spec §3 constraint 2). The contact
  sheet is written to disk and its path printed; nothing opens it.
- **The report core must be byte-stable across runs.** Durations, frame counts
  and timings belong in the measured annex, never the core.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Phases 1–3 must keep rendering.

---

### Task 1: Abort a failing run before encoding

**Files:**
- Modify: `src/driver/capture.ts`
- Modify: `src/driver/render.ts`
- Modify: `src/driver/capture.test.ts`
- Modify: `src/driver/render.test.ts`

**Interfaces:**
- `CaptureOptions` gains `onSceneFail?: 'abort' | 'continue'` (default `'abort'`)
- `CaptureArtifact` gains `abortedAt: string | null` — the scene id that stopped the run
- `renderDemo` returns without encoding when `capture.ok` is false, and deletes any stale file at the output path

- [ ] **Step 1: Write the failing test**

Append to `src/driver/capture.test.ts`:

```ts
describe('abort on failure', () => {
  it('stops after the first failing scene instead of cascading', async () => {
    const { captureDemo } = await import('./capture.js');
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];

    const result = await captureDemo(script);

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBe(script.scenes[0]!.id);
    // The second scene must not have run: its failure would be caused by
    // the first, and cascading failures bury the real cause.
    expect(result.scenes).toHaveLength(1);
  }, 120000);

  it('runs every scene when told to continue', async () => {
    const { captureDemo } = await import('./capture.js');
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];

    const result = await captureDemo(script, { onSceneFail: 'continue' });

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBeNull();
    expect(result.scenes).toHaveLength(script.scenes.length);
  }, 120000);

  it('reports no abort for a passing demo', async () => {
    const { captureDemo } = await import('./capture.js');
    const result = await captureDemo(load('fixtures/terminal/demo.yaml'));
    expect(result.ok).toBe(true);
    expect(result.abortedAt).toBeNull();
  }, 120000);
});
```

Append to `src/driver/render.test.ts`:

```ts
describe('failing runs produce no video', () => {
  it('does not encode when an assertion fails', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const out = join(dir, 'should-not-exist.mp4');

    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok).toBe(false);
    expect(report.frames).toBe(0);
    // The whole point: no plausible-looking artifact for a broken demo.
    expect(existsSync(out)).toBe(false);
  }, 120000);

  it('removes a stale video left by an earlier successful run', async () => {
    const { writeFileSync } = await import('node:fs');
    const out = join(dir, 'stale.mp4');
    writeFileSync(out, 'pretend this is last week s good render');

    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    await renderDemo(script, { outputPath: out });

    expect(existsSync(out)).toBe(false);
  }, 120000);

  it('is fast, because it never reaches the encoder', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const t0 = Date.now();
    await renderDemo(script, { outputPath: join(dir, 'fast.mp4') });
    // Capture of one short scene, then stop. The baseline took 63s.
    expect(Date.now() - t0).toBeLessThan(30000);
  }, 120000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/driver/capture.test.ts src/driver/render.test.ts`
Expected: FAIL — `abortedAt` undefined; the video is written anyway.

- [ ] **Step 3: Implement**

In `src/driver/capture.ts`:

```ts
export interface CaptureOptions {
  now?: () => number;
  framesRoot?: string;
  /**
   * What to do when a scene fails. Spec section 8: abort is the
   * documented default, because later scenes usually fail only BECAUSE
   * an earlier one did, and that noise buries the real cause.
   */
  onSceneFail?: 'abort' | 'continue';
}
```

Add `abortedAt: string | null` to `CaptureArtifact`. In the scene loop,
after pushing the scene result:

```ts
      const sceneResult = scenes[scenes.length - 1]!;
      if (!sceneResult.ok && (opts.onSceneFail ?? 'abort') === 'abort') {
        abortedAt = scene.id;
        break;
      }
```

Declare `let abortedAt: string | null = null;` beside `scenes`, and
include it in both the success return and any early return.

In `src/driver/render.ts`, immediately after `const capture = await
captureDemo(script);`:

```ts
  const scenes = capture.scenes.map(/* unchanged */);

  if (!capture.ok) {
    // Never hand back a plausible-looking video of a broken demo, and
    // never leave an older good one sitting at the output path where it
    // will be mistaken for this run's result.
    await rm(outputPath, { force: true });
    return {
      ok: false,
      outputPath,
      scenes,
      frames: 0,
      durationSec: 0,
    };
  }
```

Import `rm` from `node:fs/promises`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/driver/`
Expected: PASS.

- [ ] **Step 5: Verify by hand against the baseline**

```bash
npm run build
sed 's/click: "#submit"/click: "#nope"/' fixtures/flagship/demo.yaml > /tmp/broken.yaml
time node dist/cli/index.js render /tmp/broken.yaml --out /tmp/broken.mp4
ls /tmp/broken.mp4
```

Expected: exits 1, names the failing scene, **no mp4 written**, and
finishes far quicker than the 63s baseline.

- [ ] **Step 6: Commit**

```bash
git add src/driver/
git commit -m "fix: abort a failing run before encoding anything"
```

---

### Task 2: Heuristics for unpredicted failures

**Files:**
- Create: `src/verify/heuristics.ts`
- Test: `src/verify/heuristics.test.ts`

**Interfaces:**
- Produces:
  - `interface Finding { code: string; scene: string; detail: string }`
  - `function scanTerminalText(scene: string, text: string): Finding[]` — H001 error strings
  - `function scanBrowserText(scene: string, text: string): Finding[]` — H001 error strings
  - `function detectBlankFrame(scene: string, rgba: Buffer): Finding | null` — H002
  - `function detectFlatline(scene: string, frames: readonly Buffer[]): Finding | null` — H003
  - `function detectDurationAnomaly(durations: ReadonlyArray<{ id: string; sec: number }>): Finding[]` — H004

No OCR anywhere: the terminal's character grid and the browser's DOM text
are already exact text. Spec §8's "no OCR is required" made concrete.

- [ ] **Step 1: Write the failing test**

Create `src/verify/heuristics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  scanTerminalText,
  scanBrowserText,
  detectBlankFrame,
  detectFlatline,
  detectDurationAnomaly,
} from './heuristics.js';

const rgba = (w: number, h: number, fill: number) => Buffer.alloc(w * h * 4, fill);

describe('scanTerminalText', () => {
  it('flags a stack trace', () => {
    const f = scanTerminalText('boot', 'ok\nError: connect ECONNREFUSED\n  at Foo');
    expect(f).toHaveLength(1);
    expect(f[0]!.code).toBe('H001');
    expect(f[0]!.detail).toContain('ECONNREFUSED');
  });

  it('flags a command-not-found', () => {
    expect(scanTerminalText('x', "bash: nope: command not found")).toHaveLength(1);
  });

  it('flags a non-zero npm exit', () => {
    expect(scanTerminalText('x', 'npm ERR! code ELIFECYCLE')).toHaveLength(1);
  });

  it('does not flag ordinary output', () => {
    expect(scanTerminalText('x', 'listening on :3000\nPOST /api/orders 201')).toEqual([]);
  });

  it('does not flag the word error inside a normal sentence', () => {
    expect(scanTerminalText('x', 'no errors found')).toEqual([]);
  });
});

describe('scanBrowserText', () => {
  it('flags a framework error overlay', () => {
    expect(scanBrowserText('order', 'Unhandled Runtime Error')).toHaveLength(1);
  });

  it('flags a server error page', () => {
    expect(scanBrowserText('order', '500 Internal Server Error')).toHaveLength(1);
  });

  it('ignores ordinary page copy', () => {
    expect(scanBrowserText('order', 'Order confirmed - 24 unit(s).')).toEqual([]);
  });
});

describe('detectBlankFrame', () => {
  it('flags a frame that is a single flat colour', () => {
    const f = detectBlankFrame('order', rgba(64, 64, 0));
    expect(f?.code).toBe('H002');
  });

  it('accepts a frame with real variation', () => {
    const buf = rgba(64, 64, 0);
    for (let i = 0; i < buf.length; i += 4) buf[i] = (i / 4) % 256;
    expect(detectBlankFrame('order', buf)).toBeNull();
  });
});

describe('detectFlatline', () => {
  it('flags frames that never change', () => {
    const same = rgba(32, 32, 7);
    const f = detectFlatline('order', [same, same, same, same]);
    expect(f?.code).toBe('H003');
  });

  it('accepts frames that differ', () => {
    const frames = [rgba(32, 32, 1), rgba(32, 32, 90), rgba(32, 32, 180)];
    expect(detectFlatline('order', frames)).toBeNull();
  });

  it('says nothing about a single frame', () => {
    expect(detectFlatline('order', [rgba(32, 32, 5)])).toBeNull();
  });
});

describe('detectDurationAnomaly', () => {
  it('flags a scene far longer than its peers', () => {
    const f = detectDurationAnomaly([
      { id: 'a', sec: 3 },
      { id: 'b', sec: 4 },
      { id: 'c', sec: 60 },
    ]);
    expect(f.map((x) => x.scene)).toContain('c');
    expect(f[0]!.code).toBe('H004');
  });

  it('accepts scenes of similar length', () => {
    expect(
      detectDurationAnomaly([
        { id: 'a', sec: 3 },
        { id: 'b', sec: 4 },
        { id: 'c', sec: 5 },
      ]),
    ).toEqual([]);
  });

  it('says nothing with fewer than three scenes', () => {
    expect(detectDurationAnomaly([{ id: 'a', sec: 1 }, { id: 'b', sec: 90 }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/verify/heuristics.test.ts`
Expected: FAIL — cannot resolve `./heuristics.js`.

- [ ] **Step 3: Implement**

Create `src/verify/heuristics.ts`:

```ts
export interface Finding {
  /** H001 error text, H002 blank frame, H003 flatline, H004 duration. */
  code: string;
  scene: string;
  detail: string;
}

/**
 * Error signatures. These are matched against REAL TEXT, never pixels:
 * the terminal's character grid and the browser's DOM text are already
 * exact, so spec section 8's "no OCR is required" is literal.
 */
const TERMINAL_SIGNATURES: Array<[RegExp, string]> = [
  [/^\s*Error:/m, 'an Error was printed'],
  [/\bECONNREFUSED\b|\bENOENT\b|\bEADDRINUSE\b/, 'a system error code appeared'],
  [/command not found|is not recognized as an internal/i, 'a command was not found'],
  [/npm ERR!|yarn error|pnpm ERR/i, 'a package manager reported an error'],
  [/Traceback \(most recent call last\)/, 'a Python traceback appeared'],
  [/panic:|SIGSEGV|core dumped/i, 'a crash was reported'],
];

const BROWSER_SIGNATURES: Array<[RegExp, string]> = [
  [/Unhandled Runtime Error|Application error/i, 'a framework error overlay appeared'],
  [/\b5\d\d\b\s+(Internal Server Error|Bad Gateway|Service Unavailable)/i, 'a server error page appeared'],
  [/\b404\b\s+(Not Found|page not found)/i, 'a not-found page appeared'],
  [/This site can.t be reached|ERR_CONNECTION_REFUSED/i, 'the page failed to load'],
];

function scan(
  scene: string,
  text: string,
  signatures: ReadonlyArray<[RegExp, string]>,
): Finding[] {
  const out: Finding[] = [];
  for (const [pattern, why] of signatures) {
    const m = pattern.exec(text);
    if (m) out.push({ code: 'H001', scene, detail: `${why}: ${m[0].trim().slice(0, 120)}` });
  }
  return out;
}

export function scanTerminalText(scene: string, text: string): Finding[] {
  return scan(scene, text, TERMINAL_SIGNATURES);
}

export function scanBrowserText(scene: string, text: string): Finding[] {
  return scan(scene, text, BROWSER_SIGNATURES);
}

/** Sample every Nth pixel; a whole flat frame means nothing rendered. */
export function detectBlankFrame(scene: string, rgba: Buffer): Finding | null {
  if (rgba.length < 16) return null;
  const first = rgba.readUInt32LE(0);
  const stride = 4 * 37; // already a multiple of 4, so reads stay aligned
  for (let i = stride; i + 4 <= rgba.length; i += stride) {
    if (rgba.readUInt32LE(i) !== first) return null;
  }
  return { code: 'H002', scene, detail: 'the frame is a single flat colour — nothing rendered' };
}

/** Identical frames throughout mean the scene never moved. */
export function detectFlatline(scene: string, frames: readonly Buffer[]): Finding | null {
  if (frames.length < 2) return null;
  const first = frames[0]!;
  for (const frame of frames.slice(1)) {
    if (frame.length !== first.length) return null;
    for (let i = 0; i < frame.length; i += 4 * 101) {
      if (frame[i] !== first[i]) return null;
    }
  }
  return {
    code: 'H003',
    scene,
    detail: `${frames.length} sampled frames are identical — the scene never changed`,
  };
}

/** A scene wildly longer than its peers usually means something hung. */
export function detectDurationAnomaly(
  durations: ReadonlyArray<{ id: string; sec: number }>,
): Finding[] {
  if (durations.length < 3) return [];
  const sorted = [...durations].map((d) => d.sec).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median <= 0) return [];
  return durations
    .filter((d) => d.sec > median * 5)
    .map((d) => ({
      code: 'H004',
      scene: d.id,
      detail: `scene ran ${d.sec.toFixed(1)}s, over 5x the median of ${median.toFixed(1)}s`,
    }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/verify/heuristics.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/verify/
git commit -m "feat: heuristics for unpredicted failures, with no OCR"
```

---

### Task 3: The report core and annex

**Files:**
- Create: `src/verify/report.ts`
- Test: `src/verify/report.test.ts`
- Modify: `src/driver/render.ts`
- Modify: `src/cli/render-command.ts`

**Interfaces:**
- Produces:
  - `interface ReportCore { autocast: 1; ok: boolean; scenes: Array<{ id: string; ok: boolean; assertions: Array<{ name: string; ok: boolean; detail?: string }> }>; findings: Finding[]; abortedAt: string | null }`
  - `interface ReportMeasured { frames: number; durationSec: number; sceneSec: Record<string, number> }`
  - `interface RenderReportFile { core: ReportCore; measured: ReportMeasured }`
  - `function buildReport(...): RenderReportFile`
  - `async function writeReport(outputPath: string, report: RenderReportFile): Promise<string>` — writes `<output>.report.json`

Spec §10: the core is byte-stable and is what CI compares; anything
measured varies run to run and lives in the annex.

- [ ] **Step 1: Write the failing test**

Create `src/verify/report.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, writeReport } from './report.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const scenes = [
  { id: 'boot', ok: true, assertions: [{ name: 'process_alive', ok: true }], sec: 4.02 },
  {
    id: 'order',
    ok: false,
    assertions: [{ name: 'visible', ok: false, detail: 'not visible' }],
    sec: 3.4,
  },
];

describe('buildReport', () => {
  it('puts pass/fail and assertions in the core', () => {
    const r = buildReport({ ok: false, scenes, findings: [], abortedAt: 'order', frames: 300, durationSec: 10 });
    expect(r.core.ok).toBe(false);
    expect(r.core.scenes.map((s) => s.id)).toEqual(['boot', 'order']);
    expect(r.core.abortedAt).toBe('order');
  });

  it('keeps measured values OUT of the core', () => {
    const a = buildReport({ ok: true, scenes, findings: [], abortedAt: null, frames: 300, durationSec: 10 });
    const b = buildReport({ ok: true, scenes, findings: [], abortedAt: null, frames: 999, durationSec: 42 });
    // The core is what CI compares; it must not move because a run was
    // a few frames longer.
    expect(JSON.stringify(a.core)).toBe(JSON.stringify(b.core));
  });

  it('puts measured values in the annex', () => {
    const r = buildReport({ ok: true, scenes, findings: [], abortedAt: null, frames: 300, durationSec: 10 });
    expect(r.measured.frames).toBe(300);
    expect(r.measured.durationSec).toBe(10);
    expect(r.measured.sceneSec.boot).toBeCloseTo(4.02, 2);
  });

  it('carries findings in the core, since they are semantic', () => {
    const r = buildReport({
      ok: false,
      scenes,
      findings: [{ code: 'H001', scene: 'boot', detail: 'an Error was printed' }],
      abortedAt: null,
      frames: 1,
      durationSec: 1,
    });
    expect(r.core.findings).toHaveLength(1);
    expect(r.core.findings[0]!.code).toBe('H001');
  });

  it('is stable across repeated builds of the same input', () => {
    const one = buildReport({ ok: true, scenes, findings: [], abortedAt: null, frames: 1, durationSec: 1 });
    const two = buildReport({ ok: true, scenes, findings: [], abortedAt: null, frames: 1, durationSec: 1 });
    expect(JSON.stringify(one.core)).toBe(JSON.stringify(two.core));
  });
});

describe('writeReport', () => {
  it('writes next to the output as <name>.report.json', async () => {
    const out = join(dir, 'demo.mp4');
    const path = await writeReport(
      out,
      buildReport({ ok: true, scenes, findings: [], abortedAt: null, frames: 1, durationSec: 1 }),
    );
    expect(path).toBe(join(dir, 'demo.report.json'));
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).core.ok).toBe(true);
  });

  it('writes even when no video was produced', async () => {
    const out = join(dir, 'nested', 'failed.mp4');
    const path = await writeReport(
      out,
      buildReport({ ok: false, scenes, findings: [], abortedAt: 'order', frames: 0, durationSec: 0 }),
    );
    expect(existsSync(path)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/verify/report.test.ts`
Expected: FAIL — cannot resolve `./report.js`.

- [ ] **Step 3: Implement**

Create `src/verify/report.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';
import type { Finding } from './heuristics.js';

export interface ReportSceneCore {
  id: string;
  ok: boolean;
  assertions: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface ReportCore {
  autocast: 1;
  ok: boolean;
  scenes: ReportSceneCore[];
  findings: Finding[];
  abortedAt: string | null;
}

export interface ReportMeasured {
  frames: number;
  durationSec: number;
  sceneSec: Record<string, number>;
}

export interface RenderReportFile {
  core: ReportCore;
  measured: ReportMeasured;
}

export interface BuildReportInput {
  ok: boolean;
  scenes: Array<{
    id: string;
    ok: boolean;
    assertions: Array<{ name: string; ok: boolean; detail?: string }>;
    sec: number;
  }>;
  findings: Finding[];
  abortedAt: string | null;
  frames: number;
  durationSec: number;
}

/**
 * Split the report exactly where determinism does (spec section 10).
 *
 * The core carries semantics — what passed, what failed, what the
 * heuristics found — and is byte-stable, so CI can compare it across
 * runs. Anything measured against a wall clock varies run to run and
 * belongs in the annex.
 */
export function buildReport(input: BuildReportInput): RenderReportFile {
  return {
    core: {
      autocast: 1,
      ok: input.ok,
      scenes: input.scenes.map((s) => ({
        id: s.id,
        ok: s.ok,
        assertions: s.assertions.map((a) => ({
          name: a.name,
          ok: a.ok,
          ...(a.detail === undefined ? {} : { detail: a.detail }),
        })),
      })),
      findings: input.findings,
      abortedAt: input.abortedAt,
    },
    measured: {
      frames: input.frames,
      durationSec: input.durationSec,
      sceneSec: Object.fromEntries(input.scenes.map((s) => [s.id, s.sec])),
    },
  };
}

export async function writeReport(
  outputPath: string,
  report: RenderReportFile,
): Promise<string> {
  const dir = dirname(outputPath);
  const stem = basename(outputPath, extname(outputPath));
  const path = join(dir, `${stem}.report.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}
```

Wire into `renderDemo`: collect findings, build the report, write it on
both the success and failure paths, and add `reportPath` and `findings`
to `RenderReport`. Print the report path and any findings in
`formatRenderReport`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/verify/ src/driver/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verify/report.ts src/verify/report.test.ts src/driver/ src/cli/
git commit -m "feat: report core and measured annex written to disk"
```

---

### Task 4: The contact sheet

**Files:**
- Create: `src/verify/contact-sheet.ts`
- Test: `src/verify/contact-sheet.test.ts`
- Modify: `src/driver/render.ts`

**Interfaces:**
- Produces: `async function writeContactSheet(path: string, frames: readonly Buffer[], size: { width: number; height: number }): Promise<string>` — tiles up to 6 frames into one PNG

Spec §3 constraint 2: written to disk, path printed, **never opened**.
This is the human-gated escape hatch, so nothing in the codebase may read
it back.

- [ ] **Step 1: Write the failing test**

Create `src/verify/contact-sheet.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { writeContactSheet } from './contact-sheet.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-sheet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const size = { width: 64, height: 36 };
const frame = (fill: number) => Buffer.alloc(size.width * size.height * 4, fill);

describe('writeContactSheet', () => {
  it('writes a png', async () => {
    const path = await writeContactSheet(join(dir, 'a.png'), [frame(10), frame(200)], size);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
    const img = await loadImage(path);
    expect(img.width).toBeGreaterThan(size.width);
  });

  it('tiles several frames into one image', async () => {
    const path = await writeContactSheet(
      join(dir, 'b.png'),
      [frame(10), frame(60), frame(120), frame(200)],
      size,
    );
    const img = await loadImage(path);
    // Four frames means more than one row or column.
    expect(img.width * img.height).toBeGreaterThan(size.width * size.height);
  });

  it('caps the number of tiles', async () => {
    const many = Array.from({ length: 30 }, (_, i) => frame(i * 8));
    const path = await writeContactSheet(join(dir, 'c.png'), many, size);
    const img = await loadImage(path);
    // Six tiles at most, so the sheet cannot grow without bound.
    expect(img.width).toBeLessThanOrEqual(size.width * 3 + 40);
  });

  it('creates the directory if needed', async () => {
    const path = await writeContactSheet(join(dir, 'deep', 'd.png'), [frame(5)], size);
    expect(existsSync(path)).toBe(true);
  });

  it('handles an empty frame list without throwing', async () => {
    await expect(writeContactSheet(join(dir, 'e.png'), [], size)).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/verify/contact-sheet.test.ts`
Expected: FAIL — cannot resolve `./contact-sheet.js`.

- [ ] **Step 3: Implement**

Create `src/verify/contact-sheet.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCanvas, createImageData } from '@napi-rs/canvas';

const MAX_TILES = 6;
const COLUMNS = 3;
const GAP = 8;

/**
 * Tile sample frames from a failed run into one PNG.
 *
 * This is the human-gated escape hatch of spec section 3 constraint 2:
 * the path is printed, and nothing in this codebase ever reads the file
 * back. An agent may open it only when a human explicitly asks.
 */
export async function writeContactSheet(
  path: string,
  frames: readonly Buffer[],
  size: { width: number; height: number },
): Promise<string> {
  const picked = pickEvenly(frames, MAX_TILES);
  const cols = Math.min(COLUMNS, Math.max(1, picked.length));
  const rows = Math.max(1, Math.ceil(picked.length / cols));

  const canvas = createCanvas(
    cols * size.width + (cols + 1) * GAP,
    rows * size.height + (rows + 1) * GAP,
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  picked.forEach((frame, i) => {
    const tile = createCanvas(size.width, size.height);
    tile
      .getContext('2d')
      .putImageData(
        createImageData(new Uint8ClampedArray(frame), size.width, size.height),
        0,
        0,
      );
    const col = i % cols;
    const row = Math.floor(i / cols);
    ctx.drawImage(
      tile,
      GAP + col * (size.width + GAP),
      GAP + row * (size.height + GAP),
    );
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canvas.toBuffer('image/png'));
  return path;
}

/** Spread picks across the whole run rather than taking the first N. */
function pickEvenly<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]!);
}
```

Wire into `renderDemo`'s failure path: sample frames from the failing
scene, write `.autocast/failed/<scene>-contact.png`, and put the path on
the report. **Do not read it back anywhere.**

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/verify/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verify/contact-sheet.ts src/verify/contact-sheet.test.ts src/driver/render.ts
git commit -m "feat: human-gated contact sheet on failure"
```

---

### Task 5: Determinism and token budget

**Files:**
- Create: `src/cli/determinism.test.ts`

**Interfaces:** none — these are regression tests for spec §10 properties.

- [ ] **Step 1: Write the tests**

Create `src/cli/determinism.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { renderDemo, formatRenderReport } from '../driver/render.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-det-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function load(path: string) {
  const { script } = checkSchema(parseSource(readFileSync(path, 'utf8')));
  if (!script) throw new Error('fixture invalid');
  return script;
}

describe('determinism', () => {
  it('produces an identical report core across two runs', async () => {
    const script = load('fixtures/terminal/demo.yaml');

    const a = await renderDemo(script, { outputPath: join(dir, 'one.mp4') });
    const b = await renderDemo(script, { outputPath: join(dir, 'two.mp4') });

    const coreA = JSON.parse(readFileSync(join(dir, 'one.report.json'), 'utf8')).core;
    const coreB = JSON.parse(readFileSync(join(dir, 'two.report.json'), 'utf8')).core;

    // Semantics must be identical; wall-clock measurements need not be.
    expect(JSON.stringify(coreA)).toBe(JSON.stringify(coreB));
    expect(a.ok).toBe(b.ok);
  }, 300000);

  it('allows the measured annex to differ', async () => {
    // Not an assertion that it DOES differ — only that the split exists,
    // so a differing duration can never break the determinism check.
    const measured = JSON.parse(readFileSync(join(dir, 'one.report.json'), 'utf8')).measured;
    expect(typeof measured.durationSec).toBe('number');
    expect(typeof measured.frames).toBe('number');
  });
});

describe('token budget', () => {
  it('keeps the report flat in video length', async () => {
    const short = load('fixtures/terminal/demo.yaml');
    const long = load('fixtures/terminal/demo.yaml');
    // Same scene count, much longer video: the report must not grow.
    long.defaults = { ...long.defaults, settle: '2s' };

    const a = await renderDemo(short, { outputPath: join(dir, 'short.mp4') });
    const b = await renderDemo(long, { outputPath: join(dir, 'long.mp4') });

    expect(b.durationSec).toBeGreaterThan(a.durationSec);

    const textA = formatRenderReport(a).length;
    const textB = formatRenderReport(b).length;
    // Report size tracks scene count, never duration (spec section 9).
    expect(Math.abs(textA - textB)).toBeLessThan(80);
  }, 400000);
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run src/cli/determinism.test.ts`
Expected: PASS once Task 3 is in place.

- [ ] **Step 3: Commit**

```bash
git add src/cli/determinism.test.ts
git commit -m "test: determinism and token budget regression tests"
```

---

### Task 6: CI across three platforms

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install ffmpeg (Linux)
        if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - name: Install ffmpeg (macOS)
        if: runner.os == 'macOS'
        run: brew install ffmpeg
      - name: Install ffmpeg (Windows)
        if: runner.os == 'Windows'
        run: choco install ffmpeg -y

      - run: npm ci
      - run: npx playwright install --with-deps chromium

      - name: Doctor
        run: npm run build && node dist/cli/index.js doctor

      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Verify locally what CI will run**

```bash
npm ci && npm run typecheck && npm run build && node dist/cli/index.js doctor && npm test
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: test on linux, macos and windows"
```

---

## Phase 4 Definition of Done

- Breaking a selector makes `render` exit 1, name the failing scene, write **no mp4**, and finish far faster than the 63s baseline.
- A stale mp4 at the output path is removed when a run fails.
- Capture aborts after the first failing scene rather than cascading.
- Heuristics detect error text, blank frames, flatlines and duration anomalies, with no OCR.
- `<output>.report.json` is written on success and failure, split into a byte-stable core and a measured annex.
- Two runs of the same script produce identical report cores.
- Report size tracks scene count, not video duration.
- A contact sheet is written on failure and its path printed; nothing reads it back.
- CI runs the suite on Linux, macOS and Windows.
