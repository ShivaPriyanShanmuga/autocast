# autodemo Phase 5b — Animated and automatic zoom — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make zoom ease in rather than snap, and pick its target automatically from what the demo clicked.

**Architecture:** Browser zoom happens in the browser (spec §4.5), so animating it means stepping `Emulation.setPageScaleFactor` across a scene's tail while the screencast records the result. Each step repaints, so the animation arrives as real captured frames — natively rasterised at every intermediate scale, which no post-hoc crop could match. The easing curve and step schedule are pure functions, so they are tested without a browser.

**Tech Stack:** No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-autodemo-design.md` — especially §4.5, §5 and §7.2.

## A spec claim this plan corrects

§7.2 lists motion blur over "camera moves (pan, zoom, cursor travel)",
composited at 4x fps and box-averaged. That assumes every camera move is
compositor-side.

It is not. §4.5 puts browser zoom **in the browser**, so a zoom is baked
into captured frames and there is nothing to re-render at 4x. Motion blur
is therefore available for cursor travel, which the compositor draws, and
not for zoom. This plan implements the achievable half and records the
correction rather than shipping something weaker under the same name.

## Global Constraints

- **Node 20+**, ESM. All three platforms. **No new runtime dependencies.**
- **A demo with no `style:` behaves exactly as it does today.** Auto-zoom is opt-in; an explicit `focus:` still wins over it.
- **Zoom animation happens during the scene's own time**, never by extending capture beyond what the pacing work established. It replaces the flat `setZoom` already applied after a scene's steps.
- **Every intermediate scale is recorded in the zoom track**, or the cursor overlay drifts out of position mid-animation — the bug fixed in 5a would come straight back.
- **Auto-zoom targets the LAST click of a scene.** Zooming in and out on every click in a three-click scene is nauseating, and the exit criterion only asks that the clicked element be framed.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Phases 1–5a must keep rendering.

---

### Task 1: Spring easing and the zoom schedule

**Files:**
- Create: `src/render/zoom.ts`
- Test: `src/render/zoom.test.ts`

**Interfaces:**
- Produces:
  - `function spring(t: number): number` — eased 0..1 with a slight overshoot-and-settle
  - `interface ZoomStep { scale: number; delayMs: number }`
  - `function planZoom(from: number, to: number, opts?: { steps?: number; durationMs?: number; ease?: 'spring' | 'cubic' }): ZoomStep[]`

Pure functions, so the curve is tested without a browser.

- [ ] **Step 1: Write the failing test**

Create `src/render/zoom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spring, planZoom } from './zoom.js';

describe('spring', () => {
  it('is pinned at both ends', () => {
    expect(spring(0)).toBeCloseTo(0, 6);
    expect(spring(1)).toBeCloseTo(1, 6);
  });

  it('overshoots slightly before settling', () => {
    // The overshoot is what separates a spring from an ease-out.
    const samples = Array.from({ length: 40 }, (_, i) => spring(i / 39));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it('settles rather than oscillating away', () => {
    expect(spring(0.95)).toBeGreaterThan(0.9);
    expect(spring(0.95)).toBeLessThan(1.1);
  });

  it('clamps outside 0..1', () => {
    expect(spring(-1)).toBe(0);
    expect(spring(2)).toBe(1);
  });
});

describe('planZoom', () => {
  it('starts at the from scale and ends exactly at the to scale', () => {
    const steps = planZoom(1, 1.8);
    expect(steps[0]!.scale).toBeCloseTo(1, 2);
    expect(steps[steps.length - 1]!.scale).toBeCloseTo(1.8, 6);
  });

  it('produces several intermediate scales', () => {
    expect(planZoom(1, 1.8).length).toBeGreaterThan(5);
  });

  it('never emits a scale at or below zero', () => {
    for (const s of planZoom(1, 2)) expect(s.scale).toBeGreaterThan(0);
  });

  it('spreads the requested duration across the steps', () => {
    const steps = planZoom(1, 1.8, { durationMs: 400 });
    const total = steps.reduce((n, s) => n + s.delayMs, 0);
    expect(total).toBeGreaterThan(300);
    expect(total).toBeLessThan(500);
  });

  it('honours a step count', () => {
    expect(planZoom(1, 1.8, { steps: 6 })).toHaveLength(6);
  });

  it('returns a single settled step when there is no change', () => {
    const steps = planZoom(1.8, 1.8);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.scale).toBeCloseTo(1.8, 6);
  });

  it('can zoom back out', () => {
    const steps = planZoom(1.8, 1);
    expect(steps[steps.length - 1]!.scale).toBeCloseTo(1, 6);
  });

  it('cubic easing does not overshoot', () => {
    const steps = planZoom(1, 1.8, { ease: 'cubic' });
    for (const s of steps) expect(s.scale).toBeLessThanOrEqual(1.8 + 1e-6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/zoom.test.ts`
Expected: FAIL — cannot resolve `./zoom.js`.

- [ ] **Step 3: Implement**

Create `src/render/zoom.ts`:

```ts
import { minimumJerk } from './cursor.js';

/**
 * A spring curve: eases out with a small overshoot, then settles.
 *
 * The overshoot is the point — it is what reads as physical rather than
 * mechanical. Kept small, because a demo zoom that visibly bounces is
 * distracting.
 */
export function spring(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const decay = Math.exp(-6 * t);
  return 1 - decay * Math.cos(7.5 * t);
}

export interface ZoomStep {
  scale: number;
  /** How long to hold this scale before the next one. */
  delayMs: number;
}

export interface PlanZoomOptions {
  steps?: number;
  durationMs?: number;
  ease?: 'spring' | 'cubic';
}

const DEFAULT_STEPS = 12;
const DEFAULT_DURATION_MS = 420;

export function planZoom(
  from: number,
  to: number,
  opts: PlanZoomOptions = {},
): ZoomStep[] {
  const count = Math.max(1, opts.steps ?? DEFAULT_STEPS);
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const ease = opts.ease === 'cubic' ? minimumJerk : spring;

  if (Math.abs(to - from) < 1e-6) return [{ scale: to, delayMs: 0 }];

  const delayMs = Math.max(1, Math.round(durationMs / count));
  const steps: ZoomStep[] = [];

  for (let i = 0; i < count; i++) {
    const t = (i + 1) / count;
    // Land exactly on `to`: an eased curve that overshoots must still
    // finish at the requested scale, or the cursor track and the page
    // disagree about where things are.
    const p = i === count - 1 ? 1 : ease(t);
    steps.push({ scale: Math.max(0.01, from + (to - from) * p), delayMs });
  }

  return steps;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/zoom.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/zoom.ts src/render/zoom.test.ts
git commit -m "feat: spring easing and zoom step planning"
```

---

### Task 2: Animate the zoom in the browser

**Files:**
- Modify: `src/backends/browser/session.ts`
- Test: `src/backends/browser/zoom-animate.test.ts`

**Interfaces:**
- `BrowserSession` gains `animateZoom(to: number, opts?: PlanZoomOptions): Promise<void>` and `currentZoom(): number`

Each intermediate scale is applied and recorded, so the cursor overlay
follows the animation instead of jumping at the end.

- [ ] **Step 1: Write the failing test**

Create `src/backends/browser/zoom-animate.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';

const PORT = 34572;
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}, 30000);

afterAll(() => server.kill());

const open: BrowserSession[] = [];
const dirs: string[] = [];

async function session() {
  const dir = mkdtempSync(join(tmpdir(), 'autodemo-zoom-'));
  dirs.push(dir);
  const s = await openBrowserSession({ viewport: [640, 400], framesDir: join(dir, 'frames') });
  open.push(s);
  await s.goto(`http://127.0.0.1:${PORT}/`);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('animateZoom', () => {
  it('starts at 1', async () => {
    const s = await session();
    expect(s.currentZoom()).toBe(1);
  }, 60000);

  it('ends exactly at the requested scale', async () => {
    const s = await session();
    await s.animateZoom(1.8, { steps: 5, durationMs: 120 });
    expect(s.currentZoom()).toBeCloseTo(1.8, 6);
  }, 60000);

  it('records every intermediate scale, not just the destination', async () => {
    const s = await session();
    await s.animateZoom(1.8, { steps: 6, durationMs: 120 });
    // The cursor overlay reads this track; recording only the endpoint
    // would make the pointer jump at the end of the animation.
    expect(s.zoomTrack().length).toBeGreaterThan(3);
    const scales = s.zoomTrack().map((k) => k.scale);
    expect(new Set(scales).size).toBeGreaterThan(3);
  }, 60000);

  it('records increasing timestamps', async () => {
    const s = await session();
    await s.animateZoom(1.6, { steps: 5, durationMs: 120 });
    const ts = s.zoomTrack().map((k) => k.tSec);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
  }, 60000);

  it('can animate back out', async () => {
    const s = await session();
    await s.animateZoom(1.8, { steps: 4, durationMs: 80 });
    await s.animateZoom(1, { steps: 4, durationMs: 80 });
    expect(s.currentZoom()).toBeCloseTo(1, 6);
  }, 60000);

  it('produces captured frames while animating', async () => {
    const s = await session();
    await s.startCapture();
    await s.animateZoom(1.8, { steps: 8, durationMs: 240 });
    await s.stopCapture();
    // Each scale change repaints, so the animation is real footage
    // rather than something reconstructed afterwards.
    expect(s.manifest().frames.length).toBeGreaterThan(2);
  }, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/browser/zoom-animate.test.ts`
Expected: FAIL — `animateZoom` is not a function.

- [ ] **Step 3: Implement**

In `src/backends/browser/session.ts`, add to the interface:

```ts
  animateZoom(to: number, opts?: PlanZoomOptions): Promise<void>;
  currentZoom(): number;
```

and in the implementation:

```ts
  let zoom = 1;
```

```ts
    async animateZoom(to, opts) {
      const { planZoom } = await import('../../render/zoom.js');
      for (const step of planZoom(zoom, to, opts)) {
        await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: step.scale });
        // Record EVERY step: the cursor overlay scales from this track,
        // and an endpoint-only record makes the pointer jump.
        zoomTrack.push({ tSec: Date.now() / 1000, scale: step.scale });
        if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
      }
      zoom = to;
    },

    currentZoom: () => zoom,
```

Keep `setZoom` as the instant form, and have it update `zoom` too.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/browser/zoom-animate.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backends/browser/session.ts src/backends/browser/zoom-animate.test.ts
git commit -m "feat: animate browser zoom, recording every intermediate scale"
```

---

### Task 3: Choose the zoom target automatically

**Files:**
- Create: `src/driver/zoom-target.ts`
- Test: `src/driver/zoom-target.test.ts`
- Modify: `src/driver/capture.ts`

**Interfaces:**
- Produces:
  - `interface ZoomIntent { selector: string; source: 'focus' | 'auto' }`
  - `function zoomIntentFor(scene, style): ZoomIntent | null`

An explicit `focus:` always wins. Auto picks the **last** click of the
scene, because zooming in and out on every click in a multi-click scene
is nauseating and the exit criterion only asks that the clicked element
be framed.

- [ ] **Step 1: Write the failing test**

Create `src/driver/zoom-target.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { zoomIntentFor } from './zoom-target.js';

const auto = { zoomAuto: true, zoomOn: 'click' as const };
const off = { zoomAuto: false, zoomOn: 'click' as const };

const scene = (over: Record<string, unknown> = {}) =>
  ({ id: 's', use: 'web', ...over }) as never;

describe('zoomIntentFor', () => {
  it('prefers an explicit focus', () => {
    const i = zoomIntentFor(scene({ focus: '#explicit' }), auto);
    expect(i).toEqual({ selector: '#explicit', source: 'focus' });
  });

  it('honours focus even when auto is off', () => {
    expect(zoomIntentFor(scene({ focus: '#explicit' }), off)?.source).toBe('focus');
  });

  it('returns nothing when auto is off and there is no focus', () => {
    expect(zoomIntentFor(scene({ steps: [{ click: '#a' }] }), off)).toBeNull();
  });

  it('picks the last click when auto is on', () => {
    const i = zoomIntentFor(
      scene({ steps: [{ click: '#first' }, { fill: { selector: '#q', value: '2' } }, { click: '#last' }] }),
      auto,
    );
    // Zooming on every click in a multi-click scene is nauseating; the
    // last one is the result worth framing.
    expect(i).toEqual({ selector: '#last', source: 'auto' });
  });

  it('returns nothing when the scene has no clicks', () => {
    expect(zoomIntentFor(scene({ steps: [{ goto: 'http://x' }] }), auto)).toBeNull();
  });

  it('returns nothing for a scene with no steps', () => {
    expect(zoomIntentFor(scene({}), auto)).toBeNull();
  });

  it('ignores non-click steps when choosing', () => {
    const i = zoomIntentFor(
      scene({ steps: [{ click: '#only' }, { wait_for: { selector: '.done' } }] }),
      auto,
    );
    expect(i?.selector).toBe('#only');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/driver/zoom-target.test.ts`
Expected: FAIL — cannot resolve `./zoom-target.js`.

- [ ] **Step 3: Implement**

Create `src/driver/zoom-target.ts`:

```ts
import type { Scene } from '../schema/demo.js';

export interface ZoomIntent {
  selector: string;
  source: 'focus' | 'auto';
}

export interface ZoomStyle {
  zoomAuto: boolean;
  zoomOn: 'click' | 'focus';
}

/**
 * What a scene should frame, if anything.
 *
 * An explicit `focus:` always wins — the author said what mattered.
 * Otherwise auto-zoom picks the LAST click: we know the element's exact
 * bounding box from the DOM, which is why our framing can be better than
 * a screen recorder's guess (spec section 7.2), but zooming in and out on
 * every click in a three-click scene is nauseating.
 */
export function zoomIntentFor(scene: Scene, style: ZoomStyle): ZoomIntent | null {
  if (typeof scene.focus === 'string' && scene.focus.length > 0) {
    return { selector: scene.focus, source: 'focus' };
  }
  if (!style.zoomAuto) return null;

  const clicks = (scene.steps ?? [])
    .map((s) => (s as { click?: unknown }).click)
    .filter((c): c is string => typeof c === 'string');

  const last = clicks[clicks.length - 1];
  return last ? { selector: last, source: 'auto' } : null;
}
```

In `src/driver/capture.ts`, replace the `scene.focus` block with one that
uses `zoomIntentFor`, and call `animateZoom` instead of `setZoom`:

```ts
      const intent = zoomIntentFor(scene, {
        zoomAuto: script.style?.zoom?.auto ?? false,
        zoomOn: script.style?.zoom?.on ?? 'click',
      });

      if (entry.kind === 'browser' && intent) {
        const box = await entry.session.boundingBox(intent.selector);
        if (box === null) {
          // An explicit focus that matches nothing is an authoring error
          // worth reporting; an auto guess that misses is not.
          if (intent.source === 'focus') {
            assertions.push({
              name: 'focus',
              ok: false,
              detail:
                `focus selector ${intent.selector} matched no visible element after the ` +
                'scene ran (it may be absent, or present but not rendered)',
            });
          }
        } else {
          await entry.session.animateZoom(script.style?.zoom?.scale ?? 1.8, {
            ...(script.style?.zoom?.ease ? { ease: script.style.zoom.ease } : {}),
          });
          await new Promise((r) => setTimeout(r, settleMs));
        }
      }
```

Note the asymmetry: a missing **explicit** `focus:` is still a scene
failure, but a missing **auto** target is not — the author never asked
for it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/driver/ src/backends/browser/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/driver/zoom-target.ts src/driver/zoom-target.test.ts src/driver/capture.ts
git commit -m "feat: choose the zoom target automatically from the last click"
```

---

### Task 4: Cursor motion blur, and the flagship

**Files:**
- Modify: `src/render/cursor.ts`
- Modify: `src/render/browser-frame.ts`
- Modify: `src/render/style.ts`
- Modify: `fixtures/flagship/demo.yaml`
- Test: `src/render/cursor.test.ts`

**Interfaces:**
- `drawCursor` gains `trail?: CursorPoint[]` — earlier positions drawn at decaying alpha
- `ResolvedStyle` gains `motionBlurCursor: boolean`
- `composeBrowserWithCursor` samples a few sub-frame positions when enabled

Blur is approximated by drawing the cursor at several recent positions
with decaying alpha. Real accumulation blur would need the frame
re-rendered at 4x rate, which is impossible for a zoom baked in at
capture time — see the correction at the top of this plan.

- [ ] **Step 1: Write the failing test**

Append to `src/render/cursor.test.ts`:

```ts
describe('cursor motion blur', () => {
  it('a trail changes the drawn frame', () => {
    const plain = createCanvas(120, 120);
    drawCursor(plain.getContext('2d'), { x: 60, y: 60 }, {});

    const blurred = createCanvas(120, 120);
    drawCursor(blurred.getContext('2d'), { x: 60, y: 60 }, {
      trail: [
        { x: 20, y: 20 },
        { x: 40, y: 40 },
      ],
    });

    expect(Buffer.compare(Buffer.from(plain.data()), Buffer.from(blurred.data()))).not.toBe(0);
  });

  it('an empty trail draws exactly as no trail', () => {
    const a = createCanvas(120, 120);
    drawCursor(a.getContext('2d'), { x: 60, y: 60 }, {});
    const b = createCanvas(120, 120);
    drawCursor(b.getContext('2d'), { x: 60, y: 60 }, { trail: [] });
    expect(Buffer.compare(Buffer.from(a.data()), Buffer.from(b.data()))).toBe(0);
  });

  it('does not throw for a long trail', () => {
    const c = createCanvas(80, 80);
    const trail = Array.from({ length: 30 }, (_, i) => ({ x: i, y: i }));
    expect(() => drawCursor(c.getContext('2d'), { x: 40, y: 40 }, { trail })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/cursor.test.ts`
Expected: FAIL — `trail` has no effect.

- [ ] **Step 3: Implement**

In `src/render/cursor.ts`, extend `DrawCursorOptions` with
`trail?: CursorPoint[]`, and at the start of `drawCursor` draw each trail
point as a faded arrow before the main one:

```ts
  // Approximate motion blur: the cursor's recent positions at decaying
  // alpha. True accumulation blur would need the frame re-rendered at a
  // multiple of the frame rate, which is impossible for browser zoom
  // because it is baked in at capture time (spec 4.5).
  const trail = opts.trail ?? [];
  trail.forEach((point, i) => {
    const alpha = ((i + 1) / (trail.length + 1)) * 0.35;
    ctx.save();
    ctx.globalAlpha = alpha;
    drawArrow(ctx, point, size);
    ctx.restore();
  });
```

Extract the arrow path into `drawArrow(ctx, at, size)` and call it for
the main cursor too.

In `src/render/style.ts`, add `motionBlurCursor: style.motion_blur?.cursor ?? false`
to `ResolvedStyle` and `false` in `PLAIN`.

In `composeBrowserWithCursor`, when blur is enabled sample two earlier
points from the same `cursorAt` curve and pass them as the trail.

Add to `fixtures/flagship/demo.yaml`:

```yaml
  zoom: { auto: true, on: click, scale: 1.7, ease: spring }
  motion_blur: { cursor: true }
```

- [ ] **Step 4: Run the suite, render and LOOK**

```bash
npx vitest run
npm run typecheck
npm run build
node dist/cli/index.js render fixtures/flagship/demo.yaml --out docs/flagship-demo.mp4
```

Confirm the zoom eases in rather than snapping, that it frames the
submit button without a `focus:` hint, that the cursor stays on the
elements it clicks throughout the animation, and that the inset still
reads.

- [ ] **Step 5: Commit**

```bash
git add src/render/ fixtures/flagship/demo.yaml docs/flagship-demo.mp4
git commit -m "feat: cursor motion blur and automatic animated zoom"
```

---

## Phase 5b Definition of Done

- `npx vitest run` all green; typecheck and build clean.
- The flagship's zoom eases in with a spring rather than snapping.
- Auto-zoom frames the clicked element with no `focus:` in the scene.
- The cursor stays correctly positioned throughout the zoom animation.
- A demo without `style:` renders exactly as before.
- The spec correction about motion blur and capture-side zoom is recorded.
