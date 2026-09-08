# autodemo Phase 2b — Browser rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the sparse, variable-rate browser frames captured in Phase 2a into a fixed-rate mp4, delivering Phase 2's exit criterion — a watchable video of a real web app being used.

**Architecture:** A resampler maps a fixed 30fps timeline onto the captured frames by holding the most recent frame at each tick — mandatory, because a still page emits roughly one frame every three seconds (spec §4.5.1). Each selected JPEG is decoded, drawn onto the shared canvas at the canvas contract's size, and streamed into the same ffmpeg encoder Phase 1 already uses. A synthetic cursor is drawn by the compositor, since a headless browser has none.

**Tech Stack:** `@napi-rs/canvas` (decode + composite), existing encoder and CLI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-autodemo-design.md` — especially §4.2, §4.4, §4.5.1, §7.2 and §13.

## Global Constraints

- **Node 20+**, ESM. Windows, macOS and Linux all first-class.
- **No new runtime dependencies.**
- **The frame timeline is driven by timestamps, never by frame count** (spec §4.5.1). A still page yields ~1 frame per 3 seconds; a resampler that assumes one frame per tick produces a video that is mostly missing.
- **Hold, never interpolate.** When no new frame has arrived by a tick, repeat the last one. Blending two JPEGs would invent motion that never happened.
- **Decode is the expensive step.** Consecutive ticks frequently select the same source frame; decode it once and reuse it, or a 30fps render decodes the same JPEG 90 times in a row.
- **Frames stream to ffmpeg; never buffer the whole video** (spec §13).
- **The canvas contract is unchanged** (§4.4): one canvas, one encode, `yuv420p` + `libx264` + `+faststart`.
- **Cursor motion is compositor-side** (§7.2) — it must not perturb the page under test.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Phase 1's terminal render path must keep working unchanged; a terminal-only demo is a regression test for this phase.

---

### Task 1: The frame resampler

**Files:**
- Create: `src/render/resample.ts`
- Test: `src/render/resample.test.ts`

**Interfaces:**
- Consumes: `FrameManifest`, `StoredFrame`, `relativeTimeline` (Phase 2a)
- Produces:
  - `interface ResampleOptions { fps: number; tailMs?: number }`
  - `interface ResampledTick { index: number; tSec: number; source: StoredFrame | null }`
  - `function resampleManifest(manifest: FrameManifest, opts: ResampleOptions): ResampledTick[]`
  - `function browserFrameCount(manifest: FrameManifest, fps: number, tailMs?: number): number`

`source` is `null` only before the first captured frame — there is genuinely nothing to show yet.

- [ ] **Step 1: Write the failing test**

Create `src/render/resample.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { FrameManifest } from '../backends/browser/frame-store.js';
import { resampleManifest, browserFrameCount } from './resample.js';

/** Frames at the given RELATIVE seconds, offset onto a realistic unix base. */
function manifest(times: number[]): FrameManifest {
  const base = 1788551698.5;
  return {
    dir: '/tmp/x',
    width: 640,
    height: 400,
    frames: times.map((t, i) => ({ path: `f${i}.jpg`, tSec: base + t })),
  };
}

describe('browserFrameCount', () => {
  it('covers the captured span at the given rate', () => {
    expect(browserFrameCount(manifest([0, 1, 2]), 30, 0)).toBe(60);
  });

  it('includes the tail hold', () => {
    expect(browserFrameCount(manifest([0, 1]), 30, 1000)).toBe(60);
  });

  it('returns at least one frame for a single captured frame', () => {
    expect(browserFrameCount(manifest([0]), 30, 0)).toBeGreaterThan(0);
  });

  it('returns at least one frame for an empty manifest', () => {
    expect(browserFrameCount(manifest([]), 30, 0)).toBeGreaterThan(0);
  });
});

describe('resampleManifest', () => {
  it('produces one tick per output frame', () => {
    const m = manifest([0, 1, 2]);
    const ticks = resampleManifest(m, { fps: 10, tailMs: 0 });
    expect(ticks).toHaveLength(browserFrameCount(m, 10, 0));
  });

  it('holds the last frame across a long gap', () => {
    // One frame at t=0, nothing until t=3 — the still-page case that
    // makes holding mandatory (spec 4.5.1).
    const ticks = resampleManifest(manifest([0, 3]), { fps: 10, tailMs: 0 });
    const sources = ticks.map((t) => t.source?.path);
    expect(sources.filter((p) => p === 'f0.jpg').length).toBeGreaterThan(25);
    expect(sources[sources.length - 1]).toBe('f1.jpg');
  });

  it('advances to a newer frame once its timestamp has passed', () => {
    const ticks = resampleManifest(manifest([0, 0.5]), { fps: 10, tailMs: 0 });
    expect(ticks[0]!.source?.path).toBe('f0.jpg');
    expect(ticks[ticks.length - 1]!.source?.path).toBe('f1.jpg');
  });

  it('never goes backwards in the source sequence', () => {
    const ticks = resampleManifest(manifest([0, 0.3, 0.31, 0.9, 1.4]), { fps: 30, tailMs: 0 });
    const indices = ticks
      .filter((t) => t.source !== null)
      .map((t) => Number(t.source!.path.replace(/\D/g, '')));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]!).toBeGreaterThanOrEqual(indices[i - 1]!);
    }
  });

  it('never interpolates — every tick maps to exactly one captured frame', () => {
    const ticks = resampleManifest(manifest([0, 1]), { fps: 10, tailMs: 0 });
    const paths = new Set(ticks.map((t) => t.source?.path).filter(Boolean));
    expect([...paths].every((p) => p === 'f0.jpg' || p === 'f1.jpg')).toBe(true);
  });

  it('reports increasing output timestamps', () => {
    const ticks = resampleManifest(manifest([0, 1]), { fps: 10, tailMs: 0 });
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.tSec).toBeGreaterThan(ticks[i - 1]!.tSec);
    }
  });

  it('yields a null source only before the first captured frame', () => {
    const ticks = resampleManifest(manifest([0.5]), { fps: 10, tailMs: 0 });
    const nulls = ticks.filter((t) => t.source === null);
    for (const n of nulls) expect(n.tSec).toBeLessThan(0.5);
  });

  it('handles an empty manifest without throwing', () => {
    const ticks = resampleManifest(manifest([]), { fps: 10, tailMs: 0 });
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.source === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/resample.test.ts`
Expected: FAIL — cannot resolve `./resample.js`.

- [ ] **Step 3: Implement**

Create `src/render/resample.ts`:

```ts
import { relativeTimeline, type FrameManifest, type StoredFrame } from '../backends/browser/frame-store.js';

export interface ResampleOptions {
  fps: number;
  /** Extra time to hold the final frame so the video does not cut dead. */
  tailMs?: number;
}

export interface ResampledTick {
  index: number;
  /** Seconds from the start of the capture. */
  tSec: number;
  /** null only before the first captured frame exists. */
  source: StoredFrame | null;
}

const DEFAULT_TAIL_MS = 800;

function spanSec(frames: StoredFrame[]): number {
  return frames.length === 0 ? 0 : (frames[frames.length - 1]!.tSec ?? 0);
}

export function browserFrameCount(
  manifest: FrameManifest,
  fps: number,
  tailMs = DEFAULT_TAIL_MS,
): number {
  const total = spanSec(relativeTimeline(manifest)) + tailMs / 1000;
  return Math.max(1, Math.ceil(total * fps));
}

/**
 * Map a fixed-rate timeline onto change-driven capture.
 *
 * The screencast only emits on repaint, so a still page can go seconds
 * without a frame (spec section 4.5.1). Each tick therefore takes the
 * most recent frame whose timestamp has passed — a HOLD, never a blend:
 * interpolating two JPEGs would invent motion the page never made.
 */
export function resampleManifest(
  manifest: FrameManifest,
  opts: ResampleOptions,
): ResampledTick[] {
  const frames = relativeTimeline(manifest);
  const total = browserFrameCount(manifest, opts.fps, opts.tailMs);
  const ticks: ResampledTick[] = [];

  let cursor = -1; // index of the most recent frame whose time has passed

  for (let index = 0; index < total; index++) {
    const tSec = (index + 1) / opts.fps;
    while (cursor + 1 < frames.length && frames[cursor + 1]!.tSec <= tSec) cursor++;
    ticks.push({
      index,
      tSec,
      source: cursor >= 0 ? frames[cursor]! : null,
    });
  }

  return ticks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/resample.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/resample.ts src/render/resample.test.ts
git commit -m "feat: hold-based frame resampler for change-driven capture"
```

---

### Task 2: The browser frame compositor

**Files:**
- Create: `src/render/browser-frame.ts`
- Test: `src/render/browser-frame.test.ts`

**Interfaces:**
- Consumes: `Theme` (Phase 1b), `@napi-rs/canvas`
- Produces:
  - `interface BrowserFrameGeometry { width: number; height: number }`
  - `class BrowserFrameRenderer` with `constructor(geometry, theme)`, `async render(jpegPath: string | null): Promise<Buffer>`, `dispose(): void`
  - Internally caches the decoded image, keyed by path, so consecutive ticks holding the same frame decode once.

- [ ] **Step 1: Write the failing test**

Create `src/render/browser-frame.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { DEFAULT_THEME } from './theme.js';
import { BrowserFrameRenderer } from './browser-frame.js';

const dir = mkdtempSync(join(tmpdir(), 'autodemo-bf-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** Write a solid-colour JPEG to disk and return its path. */
function jpeg(name: string, colour: string, w = 320, h = 200): string {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  const path = join(dir, name);
  writeFileSync(path, canvas.toBuffer('image/jpeg'));
  return path;
}

const geometry = { width: 640, height: 360 };

describe('BrowserFrameRenderer', () => {
  it('returns an RGBA buffer of exactly width * height * 4', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const buf = await r.render(jpeg('a.jpg', '#ff0000'));
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
  });

  it('paints the source image', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const buf = await r.render(jpeg('red.jpg', '#ff0000'));
    // Centre pixel should be dominated by red.
    const mid = (geometry.height / 2) * geometry.width * 4 + (geometry.width / 2) * 4;
    expect(buf[mid]!).toBeGreaterThan(200);
    expect(buf[mid + 1]!).toBeLessThan(80);
  });

  it('renders a null source as the theme background rather than throwing', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const buf = await r.render(null);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
    expect(buf[0]).toBe(parseInt(DEFAULT_THEME.background.slice(1, 3), 16));
  });

  it('is deterministic for the same source', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const path = jpeg('same.jpg', '#00ff00');
    expect(Buffer.compare(await r.render(path), await r.render(path))).toBe(0);
  });

  it('distinguishes different sources', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const a = await r.render(jpeg('g.jpg', '#00ff00'));
    const b = await r.render(jpeg('b.jpg', '#0000ff'));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('decodes a repeated source only once', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const path = jpeg('cached.jpg', '#123456');
    await r.render(path);
    await r.render(path);
    await r.render(path);
    expect(r.decodeCount).toBe(1);
  });

  it('letterboxes a source with a different aspect ratio without distortion', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    // 320x200 is 1.6; the canvas is 640x360, i.e. 1.78. Fitting by height
    // leaves bars left and right, which must be background, not stretched.
    const buf = await r.render(jpeg('wide.jpg', '#ff00ff', 320, 200));
    const topLeft = buf[0];
    expect(topLeft).toBe(parseInt(DEFAULT_THEME.background.slice(1, 3), 16));
  });

  it('recovers from an unreadable file by painting the background', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const bad = join(dir, 'not-an-image.jpg');
    writeFileSync(bad, 'this is not a jpeg');
    const buf = await r.render(bad);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/browser-frame.test.ts`
Expected: FAIL — cannot resolve `./browser-frame.js`.

- [ ] **Step 3: Implement**

Create `src/render/browser-frame.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import type { Theme } from './theme.js';

export interface BrowserFrameGeometry {
  width: number;
  height: number;
}

/**
 * Draws captured browser JPEGs onto the shared canvas.
 *
 * The resampler holds one source across many ticks, so the decoded image
 * is cached: without it a 30fps render of a still page would decode the
 * same JPEG ninety times per second of video.
 */
export class BrowserFrameRenderer {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;
  private cachedPath: string | null = null;
  private cachedImage: Image | null = null;
  /** Test-visible: how many times a JPEG was actually decoded. */
  decodeCount = 0;

  constructor(
    private readonly geometry: BrowserFrameGeometry,
    private readonly theme: Theme,
  ) {
    this.canvas = createCanvas(geometry.width, geometry.height);
    this.ctx = this.canvas.getContext('2d');
  }

  private async imageFor(path: string): Promise<Image | null> {
    if (this.cachedPath === path && this.cachedImage) return this.cachedImage;
    try {
      const image = await loadImage(await readFile(path));
      this.decodeCount++;
      this.cachedPath = path;
      this.cachedImage = image;
      return image;
    } catch {
      // A frame that will not decode is a lost frame, not a lost render.
      this.cachedPath = null;
      this.cachedImage = null;
      return null;
    }
  }

  async render(jpegPath: string | null): Promise<Buffer> {
    const { ctx, geometry, theme } = this;

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, geometry.width, geometry.height);

    const image = jpegPath === null ? null : await this.imageFor(jpegPath);
    if (image) {
      // Fit inside the canvas preserving aspect ratio; never stretch.
      const scale = Math.min(geometry.width / image.width, geometry.height / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ctx.drawImage(image, (geometry.width - w) / 2, (geometry.height - h) / 2, w, h);
    }

    return Buffer.from(this.canvas.data());
  }

  dispose(): void {
    this.cachedPath = null;
    this.cachedImage = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/browser-frame.test.ts`
Expected: PASS — 8 tests.

> The letterbox test asserts the top-left pixel is background. If the
> capture and canvas aspect ratios happen to match exactly there are no
> bars — in that case widen the test's source image rather than removing
> the assertion, since aspect distortion is the bug it guards against.

- [ ] **Step 5: Commit**

```bash
git add src/render/browser-frame.ts src/render/browser-frame.test.ts
git commit -m "feat: browser frame compositor with decode caching"
```

---

### Task 3: The synthetic cursor

**Files:**
- Create: `src/render/cursor.ts`
- Test: `src/render/cursor.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface CursorPoint { x: number; y: number }`
  - `interface CursorKeyframe { tSec: number; at: CursorPoint; click?: boolean }`
  - `function minimumJerk(t: number): number` — eased 0..1
  - `function cursorAt(keyframes: CursorKeyframe[], tSec: number, travelSec?: number): { at: CursorPoint; clickAge: number | null } | null`
  - `function drawCursor(ctx: SKRSContext2D, at: CursorPoint, opts: { size?: number; clickAge?: number | null }): void`

A headless browser has no cursor, so the compositor draws one (spec §7.2). Motion uses minimum-jerk easing rather than linear, which is what makes it read as a hand rather than a machine.

- [ ] **Step 1: Write the failing test**

Create `src/render/cursor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { minimumJerk, cursorAt, drawCursor, type CursorKeyframe } from './cursor.js';

describe('minimumJerk', () => {
  it('is pinned at both ends', () => {
    expect(minimumJerk(0)).toBeCloseTo(0, 6);
    expect(minimumJerk(1)).toBeCloseTo(1, 6);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = minimumJerk(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('starts and ends slower than the middle', () => {
    const early = minimumJerk(0.1) - minimumJerk(0);
    const middle = minimumJerk(0.55) - minimumJerk(0.45);
    expect(middle).toBeGreaterThan(early);
  });

  it('clamps outside 0..1', () => {
    expect(minimumJerk(-1)).toBe(0);
    expect(minimumJerk(2)).toBe(1);
  });
});

const keys: CursorKeyframe[] = [
  { tSec: 0, at: { x: 0, y: 0 } },
  { tSec: 1, at: { x: 100, y: 50 }, click: true },
];

describe('cursorAt', () => {
  it('returns null before the first keyframe', () => {
    expect(cursorAt(keys, -0.5)).toBeNull();
  });

  it('sits on the first keyframe at its time', () => {
    const r = cursorAt(keys, 0);
    expect(r!.at.x).toBeCloseTo(0, 3);
  });

  it('reaches the target by the keyframe time', () => {
    const r = cursorAt(keys, 1);
    expect(r!.at.x).toBeCloseTo(100, 1);
    expect(r!.at.y).toBeCloseTo(50, 1);
  });

  it('moves along the path in between', () => {
    // Travel occupies the last travelSec (0.45s) before the keyframe, so
    // sample INSIDE that window. At t=0.5 the cursor has not set off yet
    // and x is still 0 — correct behaviour, not a bug.
    const mid = cursorAt(keys, 0.8)!;
    expect(mid.at.x).toBeGreaterThan(0);
    expect(mid.at.x).toBeLessThan(100);
  });

  it('holds the last position after the final keyframe', () => {
    const r = cursorAt(keys, 5);
    expect(r!.at.x).toBeCloseTo(100, 3);
  });

  it('reports the age of a recent click', () => {
    const r = cursorAt(keys, 1.05);
    expect(r!.clickAge).not.toBeNull();
    expect(r!.clickAge!).toBeGreaterThanOrEqual(0);
  });

  it('lets an old click expire', () => {
    expect(cursorAt(keys, 4)!.clickAge).toBeNull();
  });

  it('handles a single keyframe', () => {
    const r = cursorAt([{ tSec: 0, at: { x: 7, y: 9 } }], 3);
    expect(r!.at).toEqual({ x: 7, y: 9 });
  });

  it('returns null for no keyframes', () => {
    expect(cursorAt([], 1)).toBeNull();
  });
});

describe('drawCursor', () => {
  it('marks the canvas at the given point', () => {
    const canvas = createCanvas(80, 80);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 80, 80);
    const before = Buffer.from(canvas.data());

    drawCursor(ctx, { x: 40, y: 40 }, {});
    expect(Buffer.compare(before, Buffer.from(canvas.data()))).not.toBe(0);
  });

  it('draws a click pulse differently from a plain cursor', () => {
    const plain = createCanvas(80, 80);
    plain.getContext('2d').fillStyle = '#000';
    drawCursor(plain.getContext('2d'), { x: 40, y: 40 }, {});

    const clicked = createCanvas(80, 80);
    clicked.getContext('2d').fillStyle = '#000';
    drawCursor(clicked.getContext('2d'), { x: 40, y: 40 }, { clickAge: 0.05 });

    expect(Buffer.compare(Buffer.from(plain.data()), Buffer.from(clicked.data()))).not.toBe(0);
  });

  it('does not throw when drawn off-canvas', () => {
    const canvas = createCanvas(40, 40);
    expect(() => drawCursor(canvas.getContext('2d'), { x: -100, y: 900 }, {})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/cursor.test.ts`
Expected: FAIL — cannot resolve `./cursor.js`.

- [ ] **Step 3: Implement**

Create `src/render/cursor.ts`:

```ts
import type { SKRSContext2D } from '@napi-rs/canvas';

export interface CursorPoint {
  x: number;
  y: number;
}

export interface CursorKeyframe {
  tSec: number;
  at: CursorPoint;
  click?: boolean;
}

/**
 * Minimum-jerk easing: the velocity profile a human arm actually makes.
 * Linear interpolation is what reads as robotic (spec section 7.2).
 */
export function minimumJerk(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

/** How long a click pulse stays visible. */
const CLICK_PULSE_SEC = 0.35;
/** Default time taken to travel between two keyframes. */
const DEFAULT_TRAVEL_SEC = 0.45;

export function cursorAt(
  keyframes: CursorKeyframe[],
  tSec: number,
  travelSec: number = DEFAULT_TRAVEL_SEC,
): { at: CursorPoint; clickAge: number | null } | null {
  if (keyframes.length === 0) return null;
  const first = keyframes[0]!;
  if (tSec < first.tSec) return null;

  let from = first;
  let to: CursorKeyframe | null = null;
  for (const k of keyframes) {
    if (k.tSec <= tSec) from = k;
    else {
      to = k;
      break;
    }
  }

  let at: CursorPoint = from.at;
  if (to) {
    // Arrive exactly at the keyframe time, having travelled for travelSec.
    const start = Math.max(from.tSec, to.tSec - travelSec);
    const span = Math.max(to.tSec - start, 1e-6);
    const p = minimumJerk((tSec - start) / span);
    at = {
      x: from.at.x + (to.at.x - from.at.x) * p,
      y: from.at.y + (to.at.y - from.at.y) * p,
    };
  }

  let clickAge: number | null = null;
  for (const k of keyframes) {
    if (!k.click || k.tSec > tSec) continue;
    const age = tSec - k.tSec;
    if (age <= CLICK_PULSE_SEC) clickAge = age;
  }

  return { at, clickAge };
}

export interface DrawCursorOptions {
  size?: number;
  clickAge?: number | null;
}

/**
 * A headless browser has no cursor, so we draw one. Compositor-side, so
 * it never perturbs the page under test (spec section 7.2).
 */
export function drawCursor(
  ctx: SKRSContext2D,
  at: CursorPoint,
  opts: DrawCursorOptions,
): void {
  const size = opts.size ?? 18;
  const { x, y } = at;

  ctx.save();

  if (opts.clickAge !== null && opts.clickAge !== undefined) {
    const p = Math.min(opts.clickAge / 0.35, 1);
    ctx.beginPath();
    ctx.arc(x, y, size * (0.6 + p * 1.4), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(80, 140, 255, ${(1 - p) * 0.85})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Classic arrow, drawn with a light outline so it reads on any page.
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x + size * 0.29, y + size * 0.76);
  ctx.lineTo(x + size * 0.47, y + size * 1.15);
  ctx.lineTo(x + size * 0.62, y + size * 1.08);
  ctx.lineTo(x + size * 0.44, y + size * 0.69);
  ctx.lineTo(x + size * 0.72, y + size * 0.66);
  ctx.closePath();

  ctx.fillStyle = 'rgba(20, 20, 28, 0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.restore();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/cursor.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/cursor.ts src/render/cursor.test.ts
git commit -m "feat: synthetic cursor with minimum-jerk motion"
```

---

### Task 4: Cursor keyframes from captured steps

**Files:**
- Modify: `src/backends/browser/session.ts`
- Modify: `src/backends/browser/steps.ts`
- Modify: `src/driver/capture.ts`
- Test: `src/backends/browser/cursor-track.test.ts`

**Interfaces:**
- Consumes: `CursorKeyframe` (Task 3)
- Produces:
  - `BrowserSession` gains `recordPointer(at: CursorPoint, click: boolean): void` and `pointerTrack(): CursorKeyframe[]`
  - `executeBrowserStep` records a keyframe at the centre of each `click` / `fill` target before acting
  - `CaptureArtifact` gains `pointers: Record<string, CursorKeyframe[]>`

Timestamps use the same clock as the frames — unix seconds — so the two timelines line up without conversion.

- [ ] **Step 1: Write the failing test**

Create `src/backends/browser/cursor-track.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';
import { executeBrowserStep } from './steps.js';

const PORT = 34571;
const BASE = `http://127.0.0.1:${PORT}`;
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

async function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'autodemo-ct-'));
  dirs.push(dir);
  const session = await openBrowserSession({
    viewport: [640, 400],
    framesDir: join(dir, 'frames'),
  });
  open.push(session);
  return { session, settleMs: 30, now: () => Date.now() };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('pointer tracking', () => {
  it('starts empty', async () => {
    const c = await ctx();
    expect(c.session.pointerTrack()).toEqual([]);
  }, 60000);

  it('records a keyframe at the centre of a clicked element', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);

    const track = c.session.pointerTrack();
    expect(track.length).toBeGreaterThan(0);
    const last = track[track.length - 1]!;
    expect(last.click).toBe(true);
    expect(last.at.x).toBeGreaterThan(0);
    expect(last.at.y).toBeGreaterThan(0);
    expect(last.at.x).toBeLessThan(640);
  }, 60000);

  it('uses unix seconds, matching the frame clock', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    const t = c.session.pointerTrack()[0]!.tSec;
    expect(t).toBeGreaterThan(1_000_000_000);
    expect(t).toBeLessThan(100_000_000_000);
  }, 60000);

  it('records a non-click keyframe for fill', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    const before = c.session.pointerTrack().length;
    await executeBrowserStep({ fill: { selector: '#qty', value: '4' } }, c);
    expect(c.session.pointerTrack().length).toBeGreaterThan(before);
  }, 60000);

  it('records keyframes in increasing time order', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    await executeBrowserStep({ fill: { selector: '#qty', value: '2' } }, c);
    const ts = c.session.pointerTrack().map((k) => k.tSec);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
  }, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/browser/cursor-track.test.ts`
Expected: FAIL — `pointerTrack` is not a function.

- [ ] **Step 3: Implement**

In `src/backends/browser/session.ts`, add to the interface:

```ts
import type { CursorKeyframe, CursorPoint } from '../../render/cursor.js';
```

```ts
  recordPointer(at: CursorPoint, click: boolean): void;
  pointerTrack(): CursorKeyframe[];
```

And in the implementation, alongside the other collectors:

```ts
  const pointerTrack: CursorKeyframe[] = [];
```

```ts
    recordPointer(at, click) {
      // Unix seconds, the same clock the screencast stamps frames with,
      // so the two timelines need no conversion to line up.
      pointerTrack.push({ tSec: Date.now() / 1000, at, ...(click ? { click: true } : {}) });
    },

    pointerTrack: () => [...pointerTrack],
```

In `src/backends/browser/steps.ts`, record before acting. Add a helper:

```ts
async function recordTarget(
  ctx: BrowserStepContext,
  selector: string,
  click: boolean,
): Promise<void> {
  const box = await ctx.session.boundingBox(selector);
  if (box) {
    ctx.session.recordPointer(
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      click,
    );
  }
}
```

Call it at the start of the `click` and `fill` branches:

```ts
  if (typeof step.click === 'string') {
    const selector = step.click;
    await recordTarget(ctx, selector, true);
    // ...unchanged
```

```ts
  if (step.fill !== undefined) {
    const f = step.fill as { selector: string; value: string };
    await recordTarget(ctx, f.selector, false);
    // ...unchanged
```

In `src/driver/capture.ts`, collect the tracks:

```ts
export interface CaptureArtifact {
  scenes: SceneCapture[];
  casts: Record<string, CastLog>;
  frames: Record<string, FrameManifest>;
  pointers: Record<string, CursorKeyframe[]>;
  ok: boolean;
}
```

Populate it beside `frames` in both the success path and the `finally`
block, and include `pointers` in the returned object.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/backends/browser/cursor-track.test.ts
npx vitest run src/driver/capture.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/browser/ src/driver/capture.ts
git commit -m "feat: record pointer keyframes from browser steps"
```

---

### Task 5: Render a browser demo

**Files:**
- Modify: `src/driver/render.ts`
- Modify: `src/driver/render.test.ts`

**Interfaces:**
- Consumes: `resampleManifest`/`browserFrameCount` (Task 1), `BrowserFrameRenderer` (Task 2), `cursorAt`/`drawCursor` (Task 3), pointer tracks (Task 4)
- Produces: `renderDemo` handles a browser-only demo as well as a terminal-only one. Mixed demos remain Phase 3 and must fail with a clear message rather than rendering half the story.

- [ ] **Step 1: Write the failing test**

Append to `src/driver/render.test.ts`:

```ts
describe('renderDemo with a browser session', () => {
  const PORT = 34601;
  let server: import('node:child_process').ChildProcess;

  beforeAll(async () => {
    const { spawn } = await import('node:child_process');
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

  it('produces a playable mp4 of the web fixture', async () => {
    const script = load('fixtures/browser/demo.yaml');
    // The fixture points at the phase 2a port; retarget it here.
    script.scenes[0]!.steps![0] = { goto: `http://127.0.0.1:${PORT}/` };

    const out = join(dir, 'browser.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(report.frames).toBeGreaterThan(30);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
  }, 240000);

  it('refuses a mixed demo with a clear message', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.sessions.web = { backend: 'browser' };
    script.scenes.push({
      id: 'extra',
      use: 'web',
      steps: [{ goto: `http://127.0.0.1:${PORT}/` }],
      assert: [{ visible: 'body' }],
    });
    // The guard runs before capture, so this must be fast — no browser
    // launch, no terminal session.
    const t0 = Date.now();
    await expect(renderDemo(script, { outputPath: join(dir, 'mixed.mp4') })).rejects.toThrow(
      /Phase 3/i,
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 30000);
});
```

Add `beforeAll, afterAll` to the vitest import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/driver/render.test.ts`
Expected: FAIL — the browser demo produces no video.

- [ ] **Step 3: Split compose from read in the frame renderer**

The cursor must be drawn onto the composed frame before its pixels are
read, and without mutating the cached page image. Add to
`src/render/browser-frame.ts`, keeping `render` so Task 2's tests pass
unchanged:

```ts
  /** Compose the page frame; draw overlays, then call readPixels(). */
  async compose(jpegPath: string | null): Promise<void> {
    // ...exactly the body of render(), minus the return
  }

  readPixels(): Buffer {
    return Buffer.from(this.canvas.data());
  }

  /** Draw on the composed frame before it is read out. */
  get context(): SKRSContext2D {
    return this.ctx;
  }

  async render(jpegPath: string | null): Promise<Buffer> {
    await this.compose(jpegPath);
    return this.readPixels();
  }
```

- [ ] **Step 4: Implement the browser render path**

In `src/driver/render.ts`, add the imports:

```ts
import { BrowserFrameRenderer } from '../render/browser-frame.js';
import { cursorAt, drawCursor } from '../render/cursor.js';
import { browserFrameCount, resampleManifest } from '../render/resample.js';
```

Guard mixed demos **before** capturing anything — running a capture only
to discard it wastes a browser launch and a terminal session:

```ts
export async function renderDemo(
  script: DemoScript,
  opts: RenderOptions = {},
): Promise<RenderReport> {
  const outputPath = opts.outputPath ?? script.output.path;
  const [canvasW, canvasH] = script.output.canvas;
  const fps = script.output.fps;

  const kinds = new Set(Object.values(script.sessions).map((s) => s.backend));
  if (kinds.size > 1) {
    throw new Error(
      'this demo mixes terminal and browser sessions, which composes in Phase 3. ' +
        'Phase 2 renders a demo whose sessions are all one kind.',
    );
  }
  if (Object.keys(script.sessions).length > 1) {
    throw new Error(
      'this demo declares more than one session, which composes in Phase 3.',
    );
  }

  const capture = await captureDemo(script);
  // ...scenes mapping unchanged
```

Then branch on what was captured. The terminal path is exactly as before.
The browser path:

```ts
  const frameIds = Object.keys(capture.frames);
  if (frameIds.length > 0) {
    const id = frameIds[0]!;
    const manifest = capture.frames[id]!;
    const firstFrameSec = manifest.frames[0]?.tSec ?? 0;

    // Pointer keyframes are absolute unix seconds; ticks are relative to
    // the first captured frame. Rebase once, not per tick.
    const pointers = (capture.pointers[id] ?? []).map((k) => ({
      ...k,
      tSec: k.tSec - firstFrameSec,
    }));

    const ticks = resampleManifest(manifest, { fps });
    const renderer = new BrowserFrameRenderer({ width: canvasW, height: canvasH }, DEFAULT_THEME);

    async function* frames(): AsyncGenerator<Buffer> {
      for (const tick of ticks) {
        await renderer.compose(tick.source?.path ?? null);
        const cursor = cursorAt(pointers, tick.tSec);
        if (cursor) drawCursor(renderer.context, cursor.at, { clickAge: cursor.clickAge });
        yield renderer.readPixels();
      }
    }

    const { frames: written } = await encodeFrames(frames(), {
      width: canvasW,
      height: canvasH,
      fps,
      outputPath,
    });

    return {
      ok: scenes.every((s) => s.ok),
      outputPath,
      scenes,
      frames: written,
      durationSec: Number((browserFrameCount(manifest, fps) / fps).toFixed(2)),
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/render/browser-frame.test.ts
npx vitest run src/driver/render.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/browser-frame.ts src/driver/render.ts src/driver/render.test.ts
git commit -m "feat: render browser demos to mp4 with a synthetic cursor"
```

---

### Task 6: Phase 2 acceptance

**Files:**
- Modify: `src/cli/acceptance.test.ts`
- Create: `docs/browser-demo.mp4` (generated, committed as the reference artifact)

- [ ] **Step 1: Add the exit-criterion test**

Append to `src/cli/acceptance.test.ts`:

```ts
describe('Phase 2 exit criteria', () => {
  const PORT = 34602;
  let server: import('node:child_process').ChildProcess;

  beforeAll(async () => {
    const { spawn } = await import('node:child_process');
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

  it('renders a real web app to a playable mp4', async () => {
    const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { probeVideo } = await import('../render/encoder.js');

    const dir = mkdtempSync(join(tmpdir(), 'autodemo-p2-'));
    try {
      // Retarget the fixture at this test's port.
      const yaml = readFileSync('fixtures/browser/demo.yaml', 'utf8').replace(
        /127\.0\.0\.1:\d+/,
        `127.0.0.1:${PORT}`,
      );
      const script = join(dir, 'demo.yaml');
      writeFileSync(script, yaml);

      const out = join(dir, 'phase2.mp4');
      const c = captureIO();
      const code = await runCli(['render', script, '--out', out], c.io);

      expect(code, c.out() + c.err()).toBe(0);
      expect(existsSync(out)).toBe(true);

      const probe = await probeVideo(out);
      expect(probe.codec).toBe('h264');
      expect(probe.frames).toBeGreaterThan(60);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 300000);
});
```

Add `beforeAll, afterAll` to the vitest import if not already present.

- [ ] **Step 2: Run everything**

```bash
npx vitest run
npm run typecheck
npm run build
```

Expected: all green.

- [ ] **Step 3: Produce the reference video by hand**

```bash
node fixtures/web-app/server.mjs 34600 &
node dist/cli/index.js render fixtures/browser/demo.yaml --out docs/browser-demo.mp4
```

Then **watch it**. Confirm by eye:
- the page is sharp and correctly proportioned, not stretched
- the cursor moves on eased paths and pulses on click
- the order form appears, fills, and confirms
- the zoom at the end frames the form
- nothing freezes for seconds at a time where the page was actually changing

- [ ] **Step 4: Verify no orphans**

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
  Where-Object { $_.ExecutablePath -like '*ms-playwright*' } | Measure-Object
```

Expected: count 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/acceptance.test.ts docs/browser-demo.mp4
git commit -m "test: phase 2 acceptance and reference browser demo"
```

---

## Phase 2b Definition of Done

- `npx vitest run` — all green, no unhandled rejections.
- `npm run typecheck` and `npm run build` — clean.
- `autodemo render fixtures/browser/demo.yaml` writes a playable h264 / yuv420p 1280x720 mp4 and exits 0.
- The video shows the web app being driven, with a visible cursor that eases between targets and pulses on click.
- A demo mixing terminal and browser sessions fails with a message naming Phase 3, rather than silently rendering half of it.
- Phase 1's terminal demo still renders identically.
- No orphaned Playwright Chromium processes.
- No new runtime dependencies.

**Not in this plan:** multi-session composition and insets (Phase 3), idle compression (Phase 3), animated zoom framing to a bounding box (Phase 5), captions and TTS (Phase 6).
