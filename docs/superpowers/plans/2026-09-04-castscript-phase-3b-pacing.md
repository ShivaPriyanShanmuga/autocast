# castscript Phase 3b — Transitions and idle compression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut dead air out of a demo and soften every scene cut, completing the silent tool.

**Architecture:** Idle spans are read straight from timestamps — gaps between terminal cast events, and gaps between browser frames (the screencast is change-driven, so a gap *is* idleness). Those spans compress by a capped factor, turning each scene's linear output-to-wall mapping into a monotonic piecewise-linear one. Crossfades blend a snapshot of the outgoing scene's final frame over the incoming scene, which avoids ever asking a forward-only cast player to seek backwards.

**Tech Stack:** No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-castscript-design.md` — especially §4.2, §7.1 and §7.2.

## Global Constraints

- **Node 20+**, ESM. All three platforms. **No new runtime dependencies.**
- **Idle compression must never eat a scene tail.** The 0.9s tail exists because `wait_for` returns the instant its pattern matches, so a scene would otherwise cut on the frame its result appears. Compression applies to the *measured* span only; the tail is added afterwards and is never compressed.
- **Idle detection is free — do not diff pixels.** Terminal: a gap between consecutive cast event timestamps. Browser: a gap between consecutive frame timestamps, because the screencast only emits on repaint (spec §4.5.1). Spec §7.1's "inter-frame delta below threshold" describes a more expensive method than the data requires.
- **Never compress a span where something is visibly happening.** Only gaps longer than the idle threshold are candidates.
- **Compression is capped** (spec §7.1 lever 1, 8x) so a long wait becomes brief, not instant.
- **The output-to-wall mapping must stay monotonic.** A non-monotonic map would ask `CastPlayer` to seek backwards, which it rejects by design.
- **Crossfades never re-render the outgoing scene.** Snapshot its final composed frame and fade that. The outgoing scene is always in its frozen tail at a boundary, so a snapshot loses nothing.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Phase 1, 2 and 3a render paths must keep working.

---

### Task 1: Idle span detection

**Files:**
- Create: `src/render/idle.ts`
- Test: `src/render/idle.test.ts`

**Interfaces:**
- Consumes: `CastLog`, `FrameManifest`
- Produces:
  - `interface IdleSpan { startMs: number; endMs: number }` — absolute wall-clock milliseconds
  - `const IDLE_THRESHOLD_MS = 700`
  - `const MAX_SPEEDUP = 8`
  - `function castIdleSpans(cast: CastLog, thresholdMs?: number): IdleSpan[]`
  - `function manifestIdleSpans(manifest: FrameManifest, thresholdMs?: number): IdleSpan[]`
  - `function clampSpans(spans: IdleSpan[], startMs: number, endMs: number): IdleSpan[]`

Both return spans in absolute wall-clock ms so they can be intersected with a scene's measured window without further conversion.

- [ ] **Step 1: Write the failing test**

Create `src/render/idle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CastLog } from '../backends/terminal/cast.js';
import type { FrameManifest } from '../backends/browser/frame-store.js';
import {
  castIdleSpans,
  manifestIdleSpans,
  clampSpans,
  IDLE_THRESHOLD_MS,
} from './idle.js';

const EPOCH = 1788570640000;

function cast(times: number[]): CastLog {
  return {
    version: 2,
    width: 80,
    height: 24,
    timestamp: Math.floor(EPOCH / 1000),
    startedAtMs: EPOCH,
    events: times.map((t) => [t, 'o', 'x']),
  };
}

function manifest(times: number[]): FrameManifest {
  return {
    dir: '/tmp/x',
    width: 640,
    height: 400,
    frames: times.map((t, i) => ({ path: `f${i}.jpg`, tSec: EPOCH / 1000 + t })),
  };
}

describe('castIdleSpans', () => {
  it('finds a gap longer than the threshold', () => {
    // Events at 0s and 3s: 3 seconds of nothing in between.
    const spans = castIdleSpans(cast([0, 3]));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startMs).toBeCloseTo(EPOCH, -1);
    expect(spans[0]!.endMs).toBeCloseTo(EPOCH + 3000, -1);
  });

  it('ignores gaps shorter than the threshold', () => {
    expect(castIdleSpans(cast([0, 0.1, 0.2, 0.3]))).toEqual([]);
  });

  it('finds several gaps', () => {
    expect(castIdleSpans(cast([0, 2, 2.1, 5]))).toHaveLength(2);
  });

  it('honours a custom threshold', () => {
    expect(castIdleSpans(cast([0, 0.5]), 200)).toHaveLength(1);
    expect(castIdleSpans(cast([0, 0.5]), 2000)).toEqual([]);
  });

  it('returns nothing for an empty or single-event cast', () => {
    expect(castIdleSpans(cast([]))).toEqual([]);
    expect(castIdleSpans(cast([1]))).toEqual([]);
  });

  it('reports absolute wall-clock times, not relative', () => {
    const spans = castIdleSpans(cast([0, 3]));
    expect(spans[0]!.startMs).toBeGreaterThan(1_000_000_000_000);
  });
});

describe('manifestIdleSpans', () => {
  it('treats a frame gap as idleness, with no pixel diffing', () => {
    // The screencast only emits on repaint, so a gap IS nothing changing.
    const spans = manifestIdleSpans(manifest([0, 3]));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.endMs - spans[0]!.startMs).toBeCloseTo(3000, -1);
  });

  it('ignores short gaps', () => {
    expect(manifestIdleSpans(manifest([0, 0.1, 0.25]))).toEqual([]);
  });

  it('returns nothing for an empty manifest', () => {
    expect(manifestIdleSpans(manifest([]))).toEqual([]);
  });

  it('uses the same default threshold as the terminal', () => {
    const justUnder = (IDLE_THRESHOLD_MS - 50) / 1000;
    const justOver = (IDLE_THRESHOLD_MS + 50) / 1000;
    expect(manifestIdleSpans(manifest([0, justUnder]))).toEqual([]);
    expect(manifestIdleSpans(manifest([0, justOver]))).toHaveLength(1);
  });
});

describe('clampSpans', () => {
  const spans = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 5000, endMs: 9000 },
  ];

  it('drops spans entirely outside the window', () => {
    expect(clampSpans(spans, 3000, 4000)).toEqual([]);
  });

  it('keeps spans entirely inside', () => {
    expect(clampSpans(spans, 0, 10000)).toHaveLength(2);
  });

  it('trims a span that straddles the start', () => {
    const [first] = clampSpans(spans, 1500, 10000);
    expect(first!.startMs).toBe(1500);
    expect(first!.endMs).toBe(2000);
  });

  it('trims a span that straddles the end', () => {
    const result = clampSpans(spans, 0, 6000);
    expect(result[1]!.endMs).toBe(6000);
  });

  it('drops a span trimmed to nothing', () => {
    expect(clampSpans([{ startMs: 1000, endMs: 1000 }], 0, 5000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/idle.test.ts`
Expected: FAIL — cannot resolve `./idle.js`.

- [ ] **Step 3: Implement**

Create `src/render/idle.ts`:

```ts
import type { FrameManifest } from '../backends/browser/frame-store.js';
import type { CastLog } from '../backends/terminal/cast.js';

/** A stretch of wall-clock time in which nothing happened. */
export interface IdleSpan {
  startMs: number;
  endMs: number;
}

/**
 * Gaps shorter than this read as natural rhythm, not dead air. Anything
 * longer is a candidate for compression.
 */
export const IDLE_THRESHOLD_MS = 700;

/** Spec section 7.1 lever 1: a long wait becomes brief, never instant. */
export const MAX_SPEEDUP = 8;

function gapsToSpans(
  timesMs: number[],
  thresholdMs: number,
): IdleSpan[] {
  const spans: IdleSpan[] = [];
  for (let i = 1; i < timesMs.length; i++) {
    const startMs = timesMs[i - 1]!;
    const endMs = timesMs[i]!;
    if (endMs - startMs > thresholdMs) spans.push({ startMs, endMs });
  }
  return spans;
}

/** Idle is simply the gap between one cast event and the next. */
export function castIdleSpans(cast: CastLog, thresholdMs = IDLE_THRESHOLD_MS): IdleSpan[] {
  return gapsToSpans(
    cast.events.map((e) => cast.startedAtMs + e[0] * 1000),
    thresholdMs,
  );
}

/**
 * Idle is the gap between one captured frame and the next.
 *
 * No pixel diffing is needed: the screencast only emits on repaint
 * (spec section 4.5.1), so a gap already means nothing changed. Spec
 * section 7.1 describes a delta threshold, which is a more expensive
 * route to the same answer.
 */
export function manifestIdleSpans(
  manifest: FrameManifest,
  thresholdMs = IDLE_THRESHOLD_MS,
): IdleSpan[] {
  return gapsToSpans(
    manifest.frames.map((f) => f.tSec * 1000),
    thresholdMs,
  );
}

/** Intersect spans with a window, dropping anything that survives empty. */
export function clampSpans(
  spans: readonly IdleSpan[],
  startMs: number,
  endMs: number,
): IdleSpan[] {
  const out: IdleSpan[] = [];
  for (const span of spans) {
    const s = Math.max(span.startMs, startMs);
    const e = Math.min(span.endMs, endMs);
    if (e > s) out.push({ startMs: s, endMs: e });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/idle.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/idle.ts src/render/idle.test.ts
git commit -m "feat: idle span detection from timestamps alone"
```

---

### Task 2: Compress idle into the composition plan

**Files:**
- Modify: `src/render/composition.ts`
- Modify: `src/render/composition.test.ts`

**Interfaces:**
- Consumes: `IdleSpan`, `MAX_SPEEDUP` (Task 1)
- Produces:
  - `SceneWindow` gains `segments: TimeSegment[]`
  - `interface TimeSegment { outStartSec: number; outEndSec: number; wallStartMs: number; wallEndMs: number }`
  - `PlanOptions` gains `idleByScene?: Record<string, IdleSpan[]>` and `maxSpeedup?: number`
  - `wallClockAt` walks the segments instead of assuming one linear run

A scene becomes a list of segments: active stretches at 1:1, idle stretches at up to 8x, then the uncompressed tail.

- [ ] **Step 1: Write the failing test**

Append to `src/render/composition.test.ts`:

```ts
describe('idle compression', () => {
  // `boot` measured 3.1s; say 2s of that was dead air.
  const idleByScene = {
    boot: [{ startMs: BASE + 500, endMs: BASE + 2500 }],
  };

  it('shortens a scene containing idle', () => {
    const plain = planComposition(script, captures);
    const compressed = planComposition(script, captures, { idleByScene });
    const a = plain.windows[0]!;
    const b = compressed.windows[0]!;
    expect(b.outEndSec - b.outStartSec).toBeLessThan(a.outEndSec - a.outStartSec);
  });

  it('caps how much an idle span is sped up', () => {
    const compressed = planComposition(script, captures, { idleByScene, maxSpeedup: 4 });
    const boot = compressed.windows[0]!;
    // 1.1s active + 2s/4 idle + 0.9s tail = 2.5s
    expect(boot.outEndSec - boot.outStartSec).toBeCloseTo(1.1 + 0.5 + SCENE_TAIL_SEC, 2);
  });

  it('leaves the tail uncompressed', () => {
    const aggressive = planComposition(script, captures, {
      idleByScene: { boot: [{ startMs: BASE, endMs: BASE + 3100 }] },
      maxSpeedup: 100,
    });
    const boot = aggressive.windows[0]!;
    // Even with everything compressed to nothing, the tail survives.
    expect(boot.outEndSec - boot.outStartSec).toBeGreaterThanOrEqual(SCENE_TAIL_SEC);
  });

  it('does not touch scenes with no idle recorded', () => {
    const plain = planComposition(script, captures);
    const compressed = planComposition(script, captures, { idleByScene });
    const a = plain.windows[1]!;
    const b = compressed.windows[1]!;
    expect(b.outEndSec - b.outStartSec).toBeCloseTo(a.outEndSec - a.outStartSec, 6);
  });

  it('keeps the output-to-wall mapping monotonic', () => {
    const plan = planComposition(script, captures, { idleByScene });
    let previous = -Infinity;
    for (let t = 0; t < plan.totalSec; t += 1 / 30) {
      const at = wallClockAt(plan, t);
      if (!at) continue;
      // A backwards step would make CastPlayer throw.
      if (at.window.id === 'boot') {
        expect(at.wallMs).toBeGreaterThanOrEqual(previous);
        previous = at.wallMs;
      }
    }
  });

  it('still reaches the end of the captured span', () => {
    const plan = planComposition(script, captures, { idleByScene });
    const boot = plan.windows[0]!;
    const atEnd = wallClockAt(plan, boot.outEndSec - 0.01)!;
    expect(atEnd.wallMs).toBeCloseTo(BASE + 3100, 0);
  });

  it('passes through idle time faster than active time', () => {
    const plan = planComposition(script, captures, { idleByScene, maxSpeedup: 8 });
    // Sample across the compressed idle region and confirm wall time
    // advances faster there than during the active head.
    const boot = plan.windows[0]!;
    const early = wallClockAt(plan, boot.outStartSec + 0.1)!;
    const later = wallClockAt(plan, boot.outStartSec + 0.2)!;
    const activeRate = later.wallMs - early.wallMs;

    const midA = wallClockAt(plan, boot.outStartSec + 0.6)!;
    const midB = wallClockAt(plan, boot.outStartSec + 0.7)!;
    const idleRate = midB.wallMs - midA.wallMs;

    expect(idleRate).toBeGreaterThan(activeRate);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/composition.test.ts`
Expected: FAIL — `idleByScene` is ignored, so compressed durations equal plain ones.

- [ ] **Step 3: Implement**

In `src/render/composition.ts`, add the segment type and extend the plan:

```ts
import { MAX_SPEEDUP, type IdleSpan } from './idle.js';

/** A stretch of output time mapping linearly onto a stretch of wall time. */
export interface TimeSegment {
  outStartSec: number;
  outEndSec: number;
  wallStartMs: number;
  wallEndMs: number;
}
```

Add `segments: TimeSegment[]` to `SceneWindow`, and to `PlanOptions`:

```ts
  /** Idle spans per scene id, in absolute wall-clock ms. */
  idleByScene?: Record<string, IdleSpan[]>;
  maxSpeedup?: number;
```

Replace the duration calculation with segment building:

```ts
    const idle = clampSpans(opts.idleByScene?.[scene.id] ?? [], wallStartMs, wallEndMs);
    const speedup = Math.max(1, opts.maxSpeedup ?? MAX_SPEEDUP);

    // Walk the measured span, emitting an active segment at 1:1 and an
    // idle segment compressed by `speedup`.
    const segments: TimeSegment[] = [];
    let outCursor = cursor;
    let wallCursor = wallStartMs;

    const pushSegment = (wallEnd: number, divisor: number) => {
      if (wallEnd <= wallCursor) return;
      const outSpan = (wallEnd - wallCursor) / 1000 / divisor;
      segments.push({
        outStartSec: outCursor,
        outEndSec: outCursor + outSpan,
        wallStartMs: wallCursor,
        wallEndMs: wallEnd,
      });
      outCursor += outSpan;
      wallCursor = wallEnd;
    };

    for (const span of idle) {
      pushSegment(span.startMs, 1);        // active run before the gap
      pushSegment(span.endMs, speedup);    // the gap itself, compressed
    }
    pushSegment(wallEndMs, 1);             // whatever is left

    const compressedSec = outCursor - cursor;
    // The minimum applies to the compressed body; the tail is added on
    // top and is NEVER compressed — it exists so a scene's result can be
    // read, and eating it would undo that.
    const bodySec = Math.max(compressedSec, minSceneSec);
    if (bodySec > compressedSec) {
      // Pad by holding the end state, exactly as a tail does.
      segments.push({
        outStartSec: outCursor,
        outEndSec: cursor + bodySec,
        wallStartMs: wallEndMs,
        wallEndMs: wallEndMs,
      });
    }
    const durationSec = bodySec + sceneTailSec;
```

Set `segments` on the window, and keep `outStartSec` / `outEndSec` as before.

Rewrite `wallClockAt` to walk segments, falling back to the old clamp
behaviour for the tail:

```ts
  const intoSec = outSec - window.outStartSec;
  const segment = window.segments.find(
    (s) => outSec >= s.outStartSec && outSec < s.outEndSec,
  );

  if (segment) {
    const span = segment.outEndSec - segment.outStartSec;
    const progress = span <= 0 ? 1 : (outSec - segment.outStartSec) / span;
    const wallMs =
      segment.wallStartMs + progress * (segment.wallEndMs - segment.wallStartMs);
    return { window, wallMs };
  }

  // Past the last segment: the tail. Freeze on the captured end state.
  void intoSec;
  return { window, wallMs: window.wallEndMs };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/composition.test.ts`
Expected: PASS — all previous tests plus the seven new ones. Existing
tests must still pass unchanged: with no `idleByScene`, a scene has one
1:1 segment and behaves exactly as before.

- [ ] **Step 5: Commit**

```bash
git add src/render/composition.ts src/render/composition.test.ts
git commit -m "feat: compress idle spans into the composition timeline"
```

---

### Task 3: Crossfade transitions

**Files:**
- Modify: `src/render/layout.ts`
- Modify: `src/render/layout.test.ts`

**Interfaces:**
- Produces:
  - `const TRANSITION_SEC = 0.35`
  - `LayoutCompositor` gains `snapshot(): void`, `fadeInPrevious(alpha: number): void`, and `get surface(): Canvas`

`snapshot()` copies the current frame into an internal hold canvas.
`fadeInPrevious(alpha)` draws that hold over the current frame. The
outgoing scene is always in its frozen tail at a boundary, so a snapshot
loses nothing — and this never asks the forward-only `CastPlayer` to seek
backwards, which re-rendering the outgoing scene would.

- [ ] **Step 1: Write the failing test**

Append to `src/render/layout.test.ts`:

```ts
describe('crossfade', () => {
  const W = 320;
  const H = 180;

  it('snapshot then full fade reproduces the snapshotted frame', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#ff0000'));
    const red = c.readPixels();
    c.snapshot();

    c.clear();
    c.drawFullscreen(solid(W, H, '#0000ff'));
    c.fadeInPrevious(1);

    // Fully opaque: the outgoing frame wins.
    const px = (H / 2) * W * 4 + (W / 2) * 4;
    expect(c.readPixels()[px]!).toBeGreaterThan(200);
    expect(red[px]!).toBeGreaterThan(200);
  });

  it('alpha 0 leaves the incoming frame untouched', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#ff0000'));
    c.snapshot();

    c.clear();
    c.drawFullscreen(solid(W, H, '#0000ff'));
    const before = c.readPixels();
    c.fadeInPrevious(0);
    expect(Buffer.compare(before, c.readPixels())).toBe(0);
  });

  it('blends part way between the two', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#ff0000'));
    c.snapshot();

    c.clear();
    c.drawFullscreen(solid(W, H, '#0000ff'));
    c.fadeInPrevious(0.5);

    const px = (H / 2) * W * 4 + (W / 2) * 4;
    const buf = c.readPixels();
    // Both channels present: neither pure red nor pure blue.
    expect(buf[px]!).toBeGreaterThan(40);
    expect(buf[px + 2]!).toBeGreaterThan(40);
  });

  it('is a no-op before anything has been snapshotted', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#00ff00'));
    const before = c.readPixels();
    c.fadeInPrevious(0.5);
    expect(Buffer.compare(before, c.readPixels())).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/layout.test.ts`
Expected: FAIL — `snapshot` is not a function.

- [ ] **Step 3: Implement**

In `src/render/layout.ts`:

```ts
/** How long a scene cut takes to blend. */
export const TRANSITION_SEC = 0.35;
```

Add to `LayoutCompositor`:

```ts
  private hold: Canvas | null = null;

  get surface(): Canvas {
    return this.canvas;
  }

  /**
   * Remember the current frame so it can be faded out over the next
   * scene. Snapshotting is what lets a crossfade work at all: the
   * outgoing scene cannot simply be re-rendered, because a forward-only
   * CastPlayer would have to seek backwards to produce it again.
   */
  snapshot(): void {
    this.hold ??= createCanvas(this.width, this.height);
    const ctx = this.hold.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.canvas, 0, 0);
  }

  /** Draw the snapshotted frame over the current one. */
  fadeInPrevious(alpha: number): void {
    if (!this.hold || alpha <= 0) return;
    this.ctx.save();
    this.ctx.globalAlpha = Math.min(1, alpha);
    this.ctx.drawImage(this.hold, 0, 0);
    this.ctx.restore();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/layout.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/layout.ts src/render/layout.test.ts
git commit -m "feat: crossfade support in the layout compositor"
```

---

### Task 4: Wire pacing into the render

**Files:**
- Modify: `src/driver/render.ts`
- Modify: `src/driver/render.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the composed path gathers idle spans per scene, passes them to `planComposition`, and crossfades at each boundary.

Idle is detected on the session the viewer is actually watching — the
scene's `primary`, not necessarily its acting session.

- [ ] **Step 1: Write the failing test**

The compression *property* is unit-tested in Task 2, where the timeline
can be inspected directly. Do not try to prove it again here by rendering
the same script twice: the flagship starts a fixture server on a fixed
port from inside the demo, so a second render would collide with the
first. This integration test asserts the composed path still produces a
correct video once pacing is applied.

Append to `src/driver/render.test.ts`:

```ts
describe('pacing', () => {
  it('still renders a correct flagship once idle compression and fades apply', async () => {
    const script = load('fixtures/flagship/demo.yaml');
    const out = join(dir, 'paced.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(report.scenes.map((s) => s.id)).toEqual(['boot', 'order', 'logs']);
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.frames).toBe(report.frames);

    // Three scenes each keep an uncompressed 0.9s tail, so however
    // aggressively idle is compressed the video cannot collapse below
    // roughly the sum of those tails plus the minimum bodies.
    expect(report.durationSec).toBeGreaterThan(3 * SCENE_TAIL_SEC);
  }, 300000);
});
```

Import `SCENE_TAIL_SEC` from `../render/composition.js` at the top of the
file.

- [ ] **Step 2: Implement**

In `src/driver/render.ts`, inside the composed branch, before
`planComposition`:

```ts
import { castIdleSpans, manifestIdleSpans } from '../render/idle.js';
import { TRANSITION_SEC } from '../render/layout.js';
```

```ts
    // Detect idle on the session the viewer is watching — a scene's
    // `primary`, which is not always its acting session.
    const idleBySession: Record<string, ReturnType<typeof castIdleSpans>> = {};
    for (const [id, cast] of Object.entries(capture.casts)) {
      idleBySession[id] = castIdleSpans(cast);
    }
    for (const [id, manifest] of Object.entries(capture.frames)) {
      idleBySession[id] = manifestIdleSpans(manifest);
    }

    const idleByScene: Record<string, ReturnType<typeof castIdleSpans>> = {};
    for (const s of script.scenes) {
      const watched = s.layout?.primary ?? s.use;
      idleByScene[s.id] = idleBySession[watched] ?? [];
    }

    const plan = planComposition(script, capture.scenes, { idleByScene });
```

In the frame loop, snapshot at each boundary and fade at the start of
each new window:

```ts
    let previousWindowId: string | null = null;

    async function* composedFrames(): AsyncGenerator<Buffer> {
      for (let i = 0; i < totalFrames; i++) {
        const outSec = (i + 0.5) / fps;
        const at = wallClockAt(plan, outSec);
        if (!at) continue;

        const entering = previousWindowId !== null && previousWindowId !== at.window.id;
        if (entering) compositor.snapshot();

        compositor.clear();
        compositor.drawFullscreen(await surfaceFor(at.window.primary, at.wallMs));
        if (at.window.inset) {
          compositor.drawInset(
            await surfaceFor(at.window.inset.session, at.wallMs),
            at.window.inset,
          );
        }

        // Fade the outgoing scene out over the first moments of this one.
        const intoScene = outSec - at.window.outStartSec;
        if (previousWindowId !== null && intoScene < TRANSITION_SEC) {
          compositor.fadeInPrevious(1 - intoScene / TRANSITION_SEC);
        }

        previousWindowId = at.window.id;
        yield compositor.readPixels();
      }
    }
```

> The snapshot must be taken BEFORE `clear()`, on the frame where the
> window changes — at that moment the canvas still holds the outgoing
> scene's final frame.

- [ ] **Step 3: Run the suite**

```bash
npx vitest run
npm run typecheck
npm run build
```

Expected: all green.

- [ ] **Step 4: Render and WATCH**

```bash
node dist/cli/index.js render fixtures/flagship/demo.yaml --out docs/flagship-demo.mp4
```

Confirm by eye:
- scene cuts blend rather than snap
- dead air (the shell prompt sitting idle, the wait on `/api/slow`) passes quickly
- **the tail still holds**: `listening on :34700` is readable before the cut
- the cursor is still drawn
- the inset still shows `POST /api/orders 201 qty=24`

- [ ] **Step 5: Commit**

```bash
git add src/driver/render.ts src/driver/render.test.ts docs/flagship-demo.mp4
git commit -m "feat: idle compression and crossfade transitions"
```

---

## Phase 3b Definition of Done

- `npx vitest run` — all green.
- `npm run typecheck` and `npm run build` — clean.
- The flagship renders shorter than it did without compression, while its tails still hold each scene's result long enough to read.
- Scene cuts crossfade.
- The output-to-wall mapping stays monotonic — no `CastPlayer` backwards-seek errors.
- Phases 1, 2 and 3a demos still render.
- No new runtime dependencies.
