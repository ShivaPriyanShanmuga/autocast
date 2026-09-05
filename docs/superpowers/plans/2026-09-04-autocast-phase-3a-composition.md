# autocast Phase 3a — Composition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a demo whose scenes span multiple sessions of different kinds into one continuous mp4, with insets — Phase 3's exit criterion and the artifact the whole architecture exists to produce.

**Architecture:** Scenes are laid end to end on an output timeline. Each scene maps a span of output time back to wall-clock time, and each session converts wall-clock time to its own source time — a terminal replays its asciicast to that instant, a browser picks the frame held at it. Both sources are live at every frame, so a layout can show one fullscreen, or one fullscreen with the other inset, without either source needing to know.

**Tech Stack:** No new dependencies. Reuses the Phase 1b terminal renderer, the Phase 2b browser compositor and resampler, and the shared encoder.

**Spec:** `docs/superpowers/specs/2026-09-04-autocast-design.md` — especially §4.2, §4.4, §4.6 and §12.

## Global Constraints

- **Node 20+**, ESM. Windows, macOS and Linux all first-class. **No new runtime dependencies.**
- **Three clocks must be reconciled, and only one of them is currently precise.** Verified by spike on the real flagship capture:
  - Scene `startedAt`/`endedAt` are wall-clock **milliseconds**.
  - Browser frame `tSec` is **unix seconds with millisecond precision** — maps to scene times exactly, no change needed.
  - `CastLog.timestamp` is **unix seconds FLOORED**, losing up to 1s. Task 1 adds a precise epoch; never map scenes onto a cast using the floored header.
- **A scene with no steps has zero measured duration.** The spike's `logs` scene measured 0.00s. Every scene needs a minimum hold or it flashes by in a single frame.
- **Terminal replay must be monotonic and continuous across scenes.** A terminal's state at scene 3 depends on everything typed in scene 1, so the player advances forward through the whole cast and is never restarted per scene.
- **Both sources are rendered at every frame when a layout needs them.** Insets are a layout decision, not a capture one.
- **The canvas contract is unchanged** (§4.4): one canvas, one encode, `yuv420p` + `libx264` + `+faststart`. No resolution pop is the exit criterion — every source is normalised to the same canvas.
- **Frames stream to ffmpeg; never buffer the whole video** (spec §13).
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Phase 1 and Phase 2 render paths must keep working; single-session demos are regression tests for this phase.

---

### Task 1: A precise cast epoch

**Files:**
- Modify: `src/backends/terminal/cast.ts`
- Modify: `src/backends/terminal/cast.test.ts`

**Interfaces:**
- Produces: `CastLog` gains `startedAtMs: number` — wall-clock milliseconds at which recording began, unfloored. `timestamp` stays as the asciicast-v2 header field so recordings remain interoperable.

Without this, mapping a scene onto the terminal timeline is wrong by up to a second, which at 30fps is thirty frames of the wrong thing on screen.

- [ ] **Step 1: Write the failing test**

Append to `src/backends/terminal/cast.test.ts`:

```ts
describe('precise epoch', () => {
  it('records the start time in unfloored milliseconds', () => {
    const r = new CastRecorder(80, 24, fakeClock([1788570639123, 1788570639623]));
    r.record('x');
    expect(r.log().startedAtMs).toBe(1788570639123);
  });

  it('keeps the asciicast header timestamp in floored seconds', () => {
    const r = new CastRecorder(80, 24, fakeClock([1788570639123]));
    expect(r.log().timestamp).toBe(1788570639);
  });

  it('survives a jsonl round trip', () => {
    const r = new CastRecorder(80, 24, fakeClock([1788570639123, 1788570639456]));
    r.record('y');
    expect(parseJsonl(r.toJsonl()).startedAtMs).toBe(1788570639123);
  });

  it('is precise enough to place a scene within one frame at 30fps', () => {
    // The floored header would round 1788570639999 down to ...639000,
    // an error of 999ms — thirty frames at 30fps.
    const r = new CastRecorder(80, 24, fakeClock([1788570639999]));
    expect(r.log().startedAtMs % 1000).toBe(999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/terminal/cast.test.ts`
Expected: FAIL — `startedAtMs` is undefined.

- [ ] **Step 3: Implement**

In `src/backends/terminal/cast.ts`, add to the interface:

```ts
export interface CastLog {
  version: 2;
  width: number;
  height: number;
  /** Unix seconds, floored — the asciicast v2 header field. */
  timestamp: number;
  /**
   * Wall-clock milliseconds at which recording began, unfloored.
   *
   * `timestamp` loses up to a second, which is thirty frames at 30fps.
   * Composition maps scene times onto this field, never onto the header.
   */
  startedAtMs: number;
  events: CastEvent[];
}
```

In `log()`:

```ts
      timestamp: Math.floor(this.startedAt / 1000),
      startedAtMs: this.startedAt,
```

In `toJsonl()`, include it in the header object so it round-trips:

```ts
    const header = JSON.stringify({
      version: log.version,
      width: log.width,
      height: log.height,
      timestamp: log.timestamp,
      startedAtMs: log.startedAtMs,
    });
```

In `parseJsonl()`, carry it through:

```ts
  return {
    version: 2,
    width: header.width,
    height: header.height,
    timestamp: header.timestamp,
    startedAtMs: header.startedAtMs ?? header.timestamp * 1000,
    events: eventLines.map((l) => JSON.parse(l) as CastEvent),
  };
```

The `??` fallback keeps third-party asciicasts loadable.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/backends/terminal/ src/render/replay.test.ts`
Expected: PASS. Fix any test fixtures that construct a `CastLog` literal by adding `startedAtMs`.

- [ ] **Step 5: Commit**

```bash
git add src/backends/terminal/cast.ts src/backends/terminal/cast.test.ts
git commit -m "feat: precise cast epoch for scene composition"
```

---

### Task 2: The composition plan

**Files:**
- Create: `src/render/composition.ts`
- Test: `src/render/composition.test.ts`

**Interfaces:**
- Consumes: `SceneCapture` (driver), `DemoScript`
- Produces:
  - `interface InsetSpec { session: string; corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; scale: number }`
  - `interface SceneWindow { id: string; use: string; outStartSec: number; outEndSec: number; wallStartMs: number; wallEndMs: number; primary: string; inset: InsetSpec | null }`
  - `interface CompositionPlan { windows: SceneWindow[]; totalSec: number }`
  - `const MIN_SCENE_SEC = 1.2`
  - `function planComposition(script: DemoScript, scenes: SceneCapture[], opts?: { minSceneSec?: number }): CompositionPlan`
  - `function wallClockAt(plan: CompositionPlan, outSec: number): { window: SceneWindow; wallMs: number } | null`

Within a scene, wall time advances 1:1 with output time up to the scene's measured duration, then **freezes** for the remainder of the hold. A hold shows the scene's end state rather than inventing time that was never captured.

- [ ] **Step 1: Write the failing test**

Create `src/render/composition.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DemoScript } from '../schema/demo.js';
import type { SceneCapture } from '../driver/capture.js';
import { planComposition, wallClockAt, MIN_SCENE_SEC } from './composition.js';

const script = {
  autocast: 1,
  output: { path: 'x.mp4', canvas: [1280, 720], fps: 30 },
  sessions: {
    api: { backend: 'terminal' },
    web: { backend: 'browser' },
  },
  scenes: [
    { id: 'boot', use: 'api' },
    { id: 'order', use: 'web' },
    {
      id: 'logs',
      use: 'api',
      layout: { primary: 'web', inset: { session: 'api', corner: 'bottom-right', scale: 0.4 } },
    },
  ],
} as unknown as DemoScript;

const scene = (id: string, startedAt: number, endedAt: number): SceneCapture => ({
  id,
  steps: [],
  assertions: [],
  ok: true,
  startedAt,
  endedAt,
});

const BASE = 1788570640000;
const captures = [
  scene('boot', BASE, BASE + 3100),
  scene('order', BASE + 3100, BASE + 5120),
  scene('logs', BASE + 5120, BASE + 5120), // zero duration, as the spike found
];

describe('planComposition', () => {
  it('lays scenes end to end with no gaps', () => {
    const plan = planComposition(script, captures);
    expect(plan.windows.map((w) => w.id)).toEqual(['boot', 'order', 'logs']);
    for (let i = 1; i < plan.windows.length; i++) {
      expect(plan.windows[i]!.outStartSec).toBeCloseTo(plan.windows[i - 1]!.outEndSec, 6);
    }
    expect(plan.windows[0]!.outStartSec).toBe(0);
  });

  it('uses the measured duration when it exceeds the minimum', () => {
    const plan = planComposition(script, captures);
    const boot = plan.windows[0]!;
    expect(boot.outEndSec - boot.outStartSec).toBeCloseTo(3.1, 3);
  });

  it('gives a zero-duration scene a minimum hold instead of one frame', () => {
    const plan = planComposition(script, captures);
    const logs = plan.windows[2]!;
    expect(logs.outEndSec - logs.outStartSec).toBeCloseTo(MIN_SCENE_SEC, 3);
  });

  it('honours an overridden minimum', () => {
    const plan = planComposition(script, captures, { minSceneSec: 3 });
    const logs = plan.windows[2]!;
    expect(logs.outEndSec - logs.outStartSec).toBeCloseTo(3, 3);
  });

  it('reports a total equal to the last window end', () => {
    const plan = planComposition(script, captures);
    expect(plan.totalSec).toBeCloseTo(plan.windows[2]!.outEndSec, 6);
  });

  it('defaults primary to the scene session and inset to null', () => {
    const plan = planComposition(script, captures);
    expect(plan.windows[0]!.primary).toBe('api');
    expect(plan.windows[0]!.inset).toBeNull();
  });

  it('reads primary and inset from an explicit layout', () => {
    const plan = planComposition(script, captures);
    const logs = plan.windows[2]!;
    expect(logs.primary).toBe('web');
    expect(logs.inset).toEqual({ session: 'api', corner: 'bottom-right', scale: 0.4 });
  });

  it('throws when a scene references an unknown session', () => {
    const bad = { ...script, scenes: [{ id: 'x', use: 'ghost' }] } as unknown as DemoScript;
    expect(() => planComposition(bad, [scene('x', BASE, BASE + 100)])).toThrow(/ghost/);
  });
});

describe('wallClockAt', () => {
  const plan = planComposition(script, captures);

  it('returns null outside the timeline', () => {
    expect(wallClockAt(plan, -1)).toBeNull();
    expect(wallClockAt(plan, plan.totalSec + 5)).toBeNull();
  });

  it('maps the start of the timeline to the first scene start', () => {
    const r = wallClockAt(plan, 0)!;
    expect(r.window.id).toBe('boot');
    expect(r.wallMs).toBeCloseTo(BASE, 0);
  });

  it('advances wall time 1:1 inside a scene', () => {
    const r = wallClockAt(plan, 1.0)!;
    expect(r.window.id).toBe('boot');
    expect(r.wallMs).toBeCloseTo(BASE + 1000, 0);
  });

  it('selects the right scene for a later time', () => {
    const r = wallClockAt(plan, 4.0)!;
    expect(r.window.id).toBe('order');
  });

  it('freezes wall time during a hold rather than inventing time', () => {
    const logs = plan.windows[2]!;
    const early = wallClockAt(plan, logs.outStartSec + 0.05)!;
    const late = wallClockAt(plan, logs.outEndSec - 0.05)!;
    expect(early.window.id).toBe('logs');
    expect(late.window.id).toBe('logs');
    // Zero measured duration, so wall time cannot advance at all.
    expect(late.wallMs).toBeCloseTo(early.wallMs, 0);
    expect(late.wallMs).toBeCloseTo(BASE + 5120, 0);
  });

  it('never runs wall time past a scene end', () => {
    const boot = plan.windows[0]!;
    const r = wallClockAt(plan, boot.outEndSec - 0.001)!;
    expect(r.wallMs).toBeLessThanOrEqual(BASE + 3100 + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/composition.test.ts`
Expected: FAIL — cannot resolve `./composition.js`.

- [ ] **Step 3: Implement**

Create `src/render/composition.ts`:

```ts
import type { SceneCapture } from '../driver/capture.js';
import type { DemoScript } from '../schema/demo.js';

export interface InsetSpec {
  session: string;
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  scale: number;
}

export interface SceneWindow {
  id: string;
  /** The acting session — whose steps and assertions ran. */
  use: string;
  outStartSec: number;
  outEndSec: number;
  /** Wall-clock span actually captured; may be shorter than the window. */
  wallStartMs: number;
  wallEndMs: number;
  /** Session shown fullscreen. */
  primary: string;
  inset: InsetSpec | null;
}

export interface CompositionPlan {
  windows: SceneWindow[];
  totalSec: number;
}

/**
 * Shortest time any scene occupies. A scene whose steps are all
 * assertions measures zero duration — the spike's `logs` scene came out
 * at 0.00s — and without a floor it would flash by in a single frame.
 */
export const MIN_SCENE_SEC = 1.2;

export interface PlanOptions {
  minSceneSec?: number;
}

export function planComposition(
  script: DemoScript,
  scenes: SceneCapture[],
  opts: PlanOptions = {},
): CompositionPlan {
  const minSceneSec = opts.minSceneSec ?? MIN_SCENE_SEC;
  const sessionIds = new Set(Object.keys(script.sessions));
  const byId = new Map(scenes.map((s) => [s.id, s]));

  const windows: SceneWindow[] = [];
  let cursor = 0;

  for (const scene of script.scenes) {
    if (!sessionIds.has(scene.use)) {
      throw new Error(`scene "${scene.id}" uses session "${scene.use}", which is not declared`);
    }

    const captured = byId.get(scene.id);
    const wallStartMs = captured?.startedAt ?? 0;
    const wallEndMs = captured?.endedAt ?? wallStartMs;
    const measuredSec = Math.max(0, (wallEndMs - wallStartMs) / 1000);
    const durationSec = Math.max(measuredSec, minSceneSec);

    const primary = scene.layout?.primary ?? scene.use;
    if (!sessionIds.has(primary)) {
      throw new Error(
        `scene "${scene.id}" has layout.primary "${primary}", which is not declared`,
      );
    }

    const inset = scene.layout?.inset ?? null;
    if (inset && !sessionIds.has(inset.session)) {
      throw new Error(
        `scene "${scene.id}" has layout.inset.session "${inset.session}", which is not declared`,
      );
    }

    windows.push({
      id: scene.id,
      use: scene.use,
      outStartSec: cursor,
      outEndSec: cursor + durationSec,
      wallStartMs,
      wallEndMs,
      primary,
      inset,
    });
    cursor += durationSec;
  }

  return { windows, totalSec: cursor };
}

/**
 * Map a point on the output timeline back to wall-clock time.
 *
 * Inside a scene, wall time advances 1:1 until the scene's measured
 * duration runs out, then FREEZES for the remainder of the hold. Holding
 * shows the captured end state; extrapolating would invent footage that
 * was never recorded.
 */
export function wallClockAt(
  plan: CompositionPlan,
  outSec: number,
): { window: SceneWindow; wallMs: number } | null {
  if (outSec < 0 || outSec > plan.totalSec) return null;

  const window =
    plan.windows.find((w) => outSec >= w.outStartSec && outSec < w.outEndSec) ??
    plan.windows[plan.windows.length - 1];
  if (!window) return null;

  const intoSec = outSec - window.outStartSec;
  const measuredMs = window.wallEndMs - window.wallStartMs;
  const offsetMs = Math.min(intoSec * 1000, measuredMs);

  return { window, wallMs: window.wallStartMs + offsetMs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/composition.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/composition.ts src/render/composition.test.ts
git commit -m "feat: scene composition plan with minimum holds"
```

---

### Task 3: A seekable cast player

**Files:**
- Create: `src/render/cast-player.ts`
- Test: `src/render/cast-player.test.ts`

**Interfaces:**
- Consumes: `CastLog` (Task 1), `snapshotScreen`, `Theme`
- Produces:
  - `class CastPlayer` with `constructor(cast: CastLog, theme: Theme)`, `async advanceTo(tSec: number): Promise<void>`, `screen(): ScreenState`, `get position(): number`

`advanceTo` is **forward-only**: a terminal's state at any instant is the sum of everything before it, so rewinding would mean replaying from scratch. Asking to go backwards is a bug in the caller, and the player says so rather than silently showing the wrong screen.

- [ ] **Step 1: Write the failing test**

Create `src/render/cast-player.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CastLog } from '../backends/terminal/cast.js';
import { CastPlayer } from './cast-player.js';
import { DEFAULT_THEME } from './theme.js';

function cast(events: Array<[number, string]>): CastLog {
  return {
    version: 2,
    width: 40,
    height: 6,
    timestamp: 1788570639,
    startedAtMs: 1788570639123,
    events: events.map(([t, d]) => [t, 'o', d]),
  };
}

const row = (p: CastPlayer, i: number) =>
  p.screen().cells[i]!.map((c) => c.char).join('').trimEnd();

describe('CastPlayer', () => {
  it('shows nothing before the first event', async () => {
    const p = new CastPlayer(cast([[1, 'hello']]), DEFAULT_THEME);
    await p.advanceTo(0.5);
    expect(row(p, 0)).toBe('');
  });

  it('applies events up to the requested time', async () => {
    const p = new CastPlayer(cast([[0.1, 'first'], [1.0, '\r\nsecond']]), DEFAULT_THEME);
    await p.advanceTo(0.5);
    expect(row(p, 0)).toBe('first');
    expect(row(p, 1)).toBe('');
  });

  it('accumulates state as time advances', async () => {
    const p = new CastPlayer(cast([[0.1, 'first'], [1.0, '\r\nsecond']]), DEFAULT_THEME);
    await p.advanceTo(0.5);
    await p.advanceTo(1.5);
    expect(row(p, 0)).toBe('first');
    expect(row(p, 1)).toBe('second');
  });

  it('is idempotent for the same time', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(1);
    const a = row(p, 0);
    await p.advanceTo(1);
    expect(row(p, 0)).toBe(a);
  });

  it('resolves a carriage-return redraw', async () => {
    const p = new CastPlayer(cast([[0.1, 'p  10%'], [0.2, '\rp 100%']]), DEFAULT_THEME);
    await p.advanceTo(1);
    expect(row(p, 0)).toBe('p 100%');
  });

  it('reports its position', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(2.5);
    expect(p.position).toBeCloseTo(2.5, 6);
  });

  it('rejects going backwards rather than showing a wrong screen', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(2);
    await expect(p.advanceTo(1)).rejects.toThrow(/forward|backward/i);
  });

  it('carries the cast geometry into the screen', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(1);
    expect(p.screen().cols).toBe(40);
    expect(p.screen().rows).toBe(6);
  });

  it('handles an empty cast', async () => {
    const p = new CastPlayer(cast([]), DEFAULT_THEME);
    await p.advanceTo(5);
    expect(row(p, 0)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/cast-player.test.ts`
Expected: FAIL — cannot resolve `./cast-player.js`.

- [ ] **Step 3: Implement**

Create `src/render/cast-player.ts`:

```ts
import { createRequire } from 'node:module';
import type { CastLog } from '../backends/terminal/cast.js';
import { snapshotScreen, type ScreenState, type XtermLike } from './screen.js';
import type { Theme } from './theme.js';

const require = createRequire(import.meta.url);

/**
 * A seekable view of an asciicast.
 *
 * Composition interleaves sessions — terminal, then browser, then the
 * terminal again — so the terminal must be advanced to arbitrary points
 * on the output timeline while keeping everything that came before.
 *
 * Seeking is forward-only by design: a terminal's screen is the sum of
 * every byte before it, so rewinding would mean replaying from scratch.
 * A backwards request is a caller bug, and saying so beats silently
 * rendering the wrong screen.
 */
export class CastPlayer {
  private readonly term: XtermLike & { write(data: string, cb?: () => void): void };
  private next = 0;
  private at = 0;

  constructor(
    private readonly cast: CastLog,
    private readonly theme: Theme,
  ) {
    const { Terminal } = require('@xterm/headless') as {
      Terminal: new (o: Record<string, unknown>) => XtermLike & {
        write(data: string, cb?: () => void): void;
      };
    };
    this.term = new Terminal({
      cols: cast.width,
      rows: cast.height,
      allowProposedApi: true,
      scrollback: 0, // the visible screen is the frame; history is not drawn
    });
  }

  get position(): number {
    return this.at;
  }

  async advanceTo(tSec: number): Promise<void> {
    if (tSec < this.at - 1e-9) {
      throw new Error(
        `CastPlayer only seeks forward: asked for ${tSec.toFixed(3)}s ` +
          `while at ${this.at.toFixed(3)}s`,
      );
    }
    while (this.next < this.cast.events.length && this.cast.events[this.next]![0] <= tSec) {
      const data = this.cast.events[this.next]![2];
      await new Promise<void>((resolve) => this.term.write(data, resolve));
      this.next++;
    }
    this.at = tSec;
  }

  screen(): ScreenState {
    return snapshotScreen(this.term, this.theme);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/cast-player.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/cast-player.ts src/render/cast-player.test.ts
git commit -m "feat: forward-only seekable cast player"
```

---

### Task 4: The layout compositor

**Files:**
- Create: `src/render/layout.ts`
- Test: `src/render/layout.test.ts`

**Interfaces:**
- Consumes: `InsetSpec` (Task 2), `@napi-rs/canvas`
- Produces:
  - `interface Rect { x: number; y: number; width: number; height: number }`
  - `function insetRect(canvasW: number, canvasH: number, spec: InsetSpec, margin?: number): Rect`
  - `class LayoutCompositor` with `constructor(width, height, theme)`, `clear(): void`, `drawFullscreen(source: Canvas | Image): void`, `drawInset(source: Canvas | Image, spec: InsetSpec): void`, `readPixels(): Buffer`, `get context(): SKRSContext2D`

The inset gets a border and a drop shadow so it reads as a separate window rather than a rectangle of noise.

- [ ] **Step 1: Write the failing test**

Create `src/render/layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { DEFAULT_THEME } from './theme.js';
import { insetRect, LayoutCompositor } from './layout.js';
import type { InsetSpec } from './composition.js';

const spec = (over: Partial<InsetSpec> = {}): InsetSpec => ({
  session: 'api',
  corner: 'bottom-right',
  scale: 0.4,
  ...over,
});

function solid(w: number, h: number, colour: string) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  return c;
}

describe('insetRect', () => {
  it('scales relative to the canvas', () => {
    const r = insetRect(1280, 720, spec({ scale: 0.4 }));
    expect(r.width).toBeCloseTo(1280 * 0.4, 0);
  });

  it('places each corner inside the canvas', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const r = insetRect(1280, 720, spec({ corner }));
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1280);
      expect(r.y + r.height).toBeLessThanOrEqual(720);
    }
  });

  it('puts bottom-right in the lower right half', () => {
    const r = insetRect(1280, 720, spec({ corner: 'bottom-right' }));
    expect(r.x).toBeGreaterThan(640);
    expect(r.y).toBeGreaterThan(360);
  });

  it('puts top-left in the upper left', () => {
    const r = insetRect(1280, 720, spec({ corner: 'top-left' }));
    expect(r.x).toBeLessThan(640);
    expect(r.y).toBeLessThan(360);
  });

  it('preserves the canvas aspect ratio in the inset', () => {
    const r = insetRect(1280, 720, spec({ scale: 0.4 }));
    expect(r.width / r.height).toBeCloseTo(1280 / 720, 2);
  });
});

describe('LayoutCompositor', () => {
  const W = 320;
  const H = 180;

  it('returns an RGBA buffer of the right size', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    expect(c.readPixels().length).toBe(W * H * 4);
  });

  it('fills the canvas when drawing fullscreen', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#ff0000'));
    const buf = c.readPixels();
    const mid = (H / 2) * W * 4 + (W / 2) * 4;
    expect(buf[mid]!).toBeGreaterThan(200);
  });

  it('leaves the primary visible outside the inset', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#ff0000'));
    c.drawInset(solid(W, H, '#0000ff'), spec({ corner: 'bottom-right' }));
    const buf = c.readPixels();
    // Top-left is outside a bottom-right inset, so still primary red.
    const topLeft = 10 * W * 4 + 10 * 4;
    expect(buf[topLeft]!).toBeGreaterThan(200);
    expect(buf[topLeft + 2]!).toBeLessThan(80);
  });

  it('draws the inset where the rect says', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#ff0000'));
    c.drawInset(solid(W, H, '#0000ff'), spec({ corner: 'bottom-right' }));
    const r = insetRect(W, H, spec({ corner: 'bottom-right' }));
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const buf = c.readPixels();
    const px = cy * W * 4 + cx * 4;
    expect(buf[px + 2]!).toBeGreaterThan(150); // blue channel
  });

  it('produces a different frame with an inset than without', () => {
    const a = new LayoutCompositor(W, H, DEFAULT_THEME);
    a.clear();
    a.drawFullscreen(solid(W, H, '#ff0000'));
    const without = a.readPixels();

    const b = new LayoutCompositor(W, H, DEFAULT_THEME);
    b.clear();
    b.drawFullscreen(solid(W, H, '#ff0000'));
    b.drawInset(solid(W, H, '#0000ff'), spec());
    expect(Buffer.compare(without, b.readPixels())).not.toBe(0);
  });

  it('clear wipes the previous frame', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    const blank = c.readPixels();
    c.drawFullscreen(solid(W, H, '#00ff00'));
    c.clear();
    expect(Buffer.compare(blank, c.readPixels())).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/layout.test.ts`
Expected: FAIL — cannot resolve `./layout.js`.

- [ ] **Step 3: Implement**

Create `src/render/layout.ts`:

```ts
import {
  createCanvas,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import type { InsetSpec } from './composition.js';
import type { Theme } from './theme.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_MARGIN = 24;

/** Where an inset sits, keeping the canvas aspect ratio. */
export function insetRect(
  canvasW: number,
  canvasH: number,
  spec: InsetSpec,
  margin = DEFAULT_MARGIN,
): Rect {
  const width = Math.round(canvasW * spec.scale);
  const height = Math.round(width * (canvasH / canvasW));

  const left = margin;
  const right = canvasW - width - margin;
  const top = margin;
  const bottom = canvasH - height - margin;

  const x = spec.corner === 'top-left' || spec.corner === 'bottom-left' ? left : right;
  const y = spec.corner === 'top-left' || spec.corner === 'top-right' ? top : bottom;

  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

type Drawable = Canvas | Image;

/**
 * Composes one or two sources onto the shared canvas.
 *
 * Every source is normalised to this canvas, which is what makes a
 * terminal-to-browser cut continuous rather than a resolution pop
 * (spec section 4.4).
 */
export class LayoutCompositor {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly theme: Theme,
  ) {
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
  }

  get context(): SKRSContext2D {
    return this.ctx;
  }

  clear(): void {
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Fit a source to the canvas, preserving aspect ratio. */
  drawFullscreen(source: Drawable): void {
    const sw = source.width;
    const sh = source.height;
    const scale = Math.min(this.width / sw, this.height / sh);
    const w = sw * scale;
    const h = sh * scale;
    this.ctx.drawImage(source, (this.width - w) / 2, (this.height - h) / 2, w, h);
  }

  drawInset(source: Drawable, spec: InsetSpec): void {
    const r = insetRect(this.width, this.height, spec);
    const { ctx } = this;

    ctx.save();

    // A shadow and border so the inset reads as a separate window rather
    // than a rectangle of noise pasted over the primary.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    const scale = Math.min(r.width / source.width, r.height / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.drawImage(source, r.x + (r.width - w) / 2, r.y + (r.height - h) / 2, w, h);
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
  }

  readPixels(): Buffer {
    return Buffer.from(this.canvas.data());
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/layout.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout.ts src/render/layout.test.ts
git commit -m "feat: layout compositor with insets"
```

---

### Task 5: Render a composed demo

**Files:**
- Modify: `src/render/frame.ts` (expose the composed canvas)
- Modify: `src/render/browser-frame.ts` (expose the composed canvas)
- Modify: `src/driver/render.ts`
- Modify: `src/driver/render.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `renderDemo` handles any number of sessions of either kind. The single-session paths stay as they are, so Phase 1 and Phase 2 keep their behaviour.

Both existing renderers already own a canvas; expose it so the layout compositor can draw from them without a pixel round trip.

- [ ] **Step 1: Expose the source canvases**

In `src/render/frame.ts`, add to `FrameRenderer`:

```ts
  /** The composed frame, for a compositor to draw from. */
  get surface(): Canvas {
    return this.canvas;
  }
```

Split `render` the same way `BrowserFrameRenderer` is split:

```ts
  compose(screen: ScreenState): void { /* the existing body, minus the return */ }

  render(screen: ScreenState): Buffer {
    this.compose(screen);
    return Buffer.from(this.canvas.data());
  }
```

In `src/render/browser-frame.ts`, add the same accessor:

```ts
  get surface(): Canvas {
    return this.canvas;
  }
```

- [ ] **Step 2: Write the failing test**

Append to `src/driver/render.test.ts`:

```ts
describe('renderDemo with mixed sessions', () => {
  it('renders the flagship as one continuous mp4 and holds the step-less scene', async () => {
    const script = load('fixtures/flagship/demo.yaml');
    const out = join(dir, 'flagship.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(report.scenes.map((s) => s.id)).toEqual(['boot', 'order', 'logs']);
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
    expect(report.frames).toBeGreaterThan(90);

    // The `logs` scene has no steps; without a minimum hold the video
    // would be barely longer than the two acting scenes.
    expect(report.durationSec).toBeGreaterThan(4);
  }, 300000);
});

Deliberately ONE render, not two. The flagship starts a server on a fixed
port from inside the demo, so a second render in the same file would hit
EADDRINUSE if teardown ever slipped — turning a teardown bug into a
confusing port error. Assert both properties from one render instead.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/driver/render.test.ts`
Expected: FAIL — `renderDemo` still throws "composes in Phase 3".

- [ ] **Step 4: Implement the composed path**

In `src/driver/render.ts`, remove the two Phase 3 guards and add a composed
path that runs when more than one session is declared, or when a scene
carries a layout. Keep the single-session fast paths untouched.

```ts
import { CastPlayer } from '../render/cast-player.js';
import { planComposition, wallClockAt } from '../render/composition.js';
import { LayoutCompositor } from '../render/layout.js';
import { fitGeometry, FrameRenderer } from '../render/frame.js';
```

```ts
  const needsComposition =
    Object.keys(script.sessions).length > 1 ||
    script.scenes.some((s) => s.layout !== undefined);

  if (needsComposition) {
    const plan = planComposition(script, capture.scenes);
    const compositor = new LayoutCompositor(canvasW, canvasH, DEFAULT_THEME);

    // One live source per session, all advanced in lockstep.
    const players = new Map<string, CastPlayer>();
    const terminalRenderers = new Map<string, FrameRenderer>();
    for (const [id, cast] of Object.entries(capture.casts)) {
      players.set(id, new CastPlayer(cast, DEFAULT_THEME));
      terminalRenderers.set(
        id,
        new FrameRenderer(fitGeometry(cast.width, cast.height, canvasW, canvasH), DEFAULT_THEME),
      );
    }

    const browsers = new Map<string, BrowserFrameRenderer>();
    const browserTicks = new Map<string, ReturnType<typeof resampleManifest>>();
    for (const [id, manifest] of Object.entries(capture.frames)) {
      browsers.set(id, new BrowserFrameRenderer({ width: canvasW, height: canvasH }, DEFAULT_THEME));
      browserTicks.set(id, resampleManifest(manifest, { fps, tailMs: 0 }));
    }

    /** Draw one session's current state onto its own canvas. */
    async function surfaceFor(sessionId: string, wallMs: number) {
      const player = players.get(sessionId);
      if (player) {
        const cast = capture.casts[sessionId]!;
        const tSec = Math.max(0, (wallMs - cast.startedAtMs) / 1000);
        // Forward-only: never rewind past where we already are.
        if (tSec >= player.position) await player.advanceTo(tSec);
        const renderer = terminalRenderers.get(sessionId)!;
        renderer.compose(player.screen());
        return renderer.surface;
      }

      const manifest = capture.frames[sessionId];
      const browser = browsers.get(sessionId);
      if (!manifest || !browser) throw new Error(`no captured source for session "${sessionId}"`);
      const firstSec = manifest.frames[0]?.tSec ?? 0;
      const tSec = Math.max(0, wallMs / 1000 - firstSec);
      const ticks = browserTicks.get(sessionId)!;
      // Last tick whose time has passed; hold it otherwise (spec 4.5.1).
      let chosen = ticks[0] ?? null;
      for (const tick of ticks) {
        if (tick.tSec <= tSec) chosen = tick;
        else break;
      }
      await browser.compose(chosen?.source?.path ?? null);
      return browser.surface;
    }

    const totalFrames = Math.max(1, Math.ceil(plan.totalSec * fps));

    async function* composedFrames(): AsyncGenerator<Buffer> {
      for (let i = 0; i < totalFrames; i++) {
        const outSec = (i + 0.5) / fps;
        const at = wallClockAt(plan, outSec);
        if (!at) continue;

        compositor.clear();
        compositor.drawFullscreen(await surfaceFor(at.window.primary, at.wallMs));
        if (at.window.inset) {
          compositor.drawInset(
            await surfaceFor(at.window.inset.session, at.wallMs),
            at.window.inset,
          );
        }
        yield compositor.readPixels();
      }
    }

    const encoded = await encodeFrames(composedFrames(), {
      width: canvasW,
      height: canvasH,
      fps,
      outputPath,
    });

    return {
      ok: scenes.every((s) => s.ok),
      outputPath,
      scenes,
      frames: encoded.frames,
      durationSec: Number(plan.totalSec.toFixed(2)),
    };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/driver/render.test.ts
npx vitest run
npm run typecheck
```

Expected: all green, including the Phase 1 and Phase 2 render tests.

- [ ] **Step 6: Commit**

```bash
git add src/render/frame.ts src/render/browser-frame.ts src/driver/render.ts src/driver/render.test.ts
git commit -m "feat: compose multi-session demos onto one timeline"
```

---

### Task 6: Phase 3 acceptance

**Files:**
- Modify: `src/cli/acceptance.test.ts`
- Create: `docs/flagship-demo.mp4`

- [ ] **Step 1: Add the exit-criterion test**

```ts
describe('Phase 3 exit criteria', () => {
  it('renders terminal, browser and inset as one continuous artifact', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { probeVideo } = await import('../render/encoder.js');

    const dir = mkdtempSync(join(tmpdir(), 'autocast-p3-'));
    try {
      const out = join(dir, 'flagship.mp4');
      const c = captureIO();
      const code = await runCli(['render', 'fixtures/flagship/demo.yaml', '--out', out], c.io);

      expect(code, c.out() + c.err()).toBe(0);
      expect(existsSync(out)).toBe(true);

      const probe = await probeVideo(out);
      // One canvas throughout: the absence of a resolution change IS the
      // exit criterion.
      expect(probe.width).toBe(1280);
      expect(probe.height).toBe(720);
      expect(probe.codec).toBe('h264');
      expect(probe.frames).toBeGreaterThan(90);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 300000);
});
```

- [ ] **Step 2: Run everything**

```bash
npx vitest run
npm run typecheck
npm run build
```

- [ ] **Step 3: Produce the flagship by hand and WATCH it**

```bash
node dist/cli/index.js render fixtures/flagship/demo.yaml --out docs/flagship-demo.mp4
```

Confirm by eye:
- the terminal types the server command and shows `listening on :34700`
- it cuts to the browser, which orders 24 units
- the final scene shows the browser with the terminal inset in the corner
- **the inset contains the `POST /api/orders 201 qty=24` line** — the browser's own request, visible in the server's log
- no resolution change or letterbox jump at any cut
- the final scene holds long enough to read

- [ ] **Step 4: Verify no orphans**

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.ExecutablePath -like '*ms-playwright*' } | Measure-Object
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server.mjs*' } | Measure-Object
```

Expected: both 0. The flagship starts a server from inside the demo, so a
leak here would be the pipeline failing to kill its own child.

- [ ] **Step 5: Commit**

```bash
git add src/cli/acceptance.test.ts docs/flagship-demo.mp4 fixtures/flagship/
git commit -m "test: phase 3 acceptance and the flagship demo"
```

---

## Phase 3a Definition of Done

- `npx vitest run` — all green, no unhandled rejections.
- `npm run typecheck` and `npm run build` — clean.
- `autocast render fixtures/flagship/demo.yaml` writes one 1280x720 h264 mp4 covering all three scenes and exits 0.
- The video shows terminal, then browser, then browser-with-terminal-inset, with the inset displaying the request the browser itself made.
- No resolution change at any scene boundary.
- A step-less scene is held, not flashed.
- Phase 1 and Phase 2 single-session demos still render unchanged.
- No orphaned Chromium or fixture-server processes.

**Not in this plan (Phase 3b):** crossfade transitions between scenes, and idle compression.
