# castscript Phase 5a — Presentation frame — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the output something you would post publicly, by wrapping every frame in a presentation frame — gradient background, padding, rounded corners, drop shadow — and fixing the cursor's position under zoom.

**Architecture:** The `style:` block, validated but unused since Phase 0, finally drives rendering. Everything here is a compositor pass over the finished canvas, so it cannot perturb capture, cannot change timing, and re-renders without re-running anything. The one non-cosmetic fix is the cursor: pointer keyframes are recorded in CSS pixels, so once `setPageScaleFactor` applies they are drawn in the wrong place.

**Tech Stack:** No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-castscript-design.md` — especially §4.5, §5 and §7.2.

## Global Constraints

- **Node 20+**, ESM. All three platforms. **No new runtime dependencies.**
- **Presentation is compositor-side only.** No capture code changes in this plan, so a styled render and a plain one capture identically.
- **`style:` is optional and omitting it changes nothing.** Every existing demo must render byte-identically without a `style:` block.
- **Cursor coordinates must follow the page scale.** Keyframes are CSS pixels; when a scene zooms, the drawn position must scale with it or the pointer sits somewhere it never was.
- **No new schema fields.** `style:` was defined in Phase 0 and is already validated; this plan implements it, it does not extend it.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Phases 1–4 must keep rendering, and every existing test must keep passing.

---

### Task 1: Resolve the style block

**Files:**
- Create: `src/render/style.ts`
- Test: `src/render/style.test.ts`

**Interfaces:**
- Produces:
  - `interface ResolvedStyle { background: { kind: 'none' } | { kind: 'solid'; color: string } | { kind: 'gradient'; colors: string[] }; padding: number; radius: number; shadow: boolean; cursorSize: number }`
  - `const PLAIN: ResolvedStyle` — what a demo with no `style:` gets
  - `function resolveStyle(style: DemoScript['style']): ResolvedStyle`

`PLAIN` must produce output identical to today's: no padding, no
background, no rounding.

- [ ] **Step 1: Write the failing test**

Create `src/render/style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveStyle, PLAIN } from './style.js';

describe('resolveStyle', () => {
  it('returns the plain style when style is absent', () => {
    expect(resolveStyle(undefined)).toEqual(PLAIN);
  });

  it('plain means no padding, no rounding and no background', () => {
    // An existing demo without style: must render exactly as before.
    expect(PLAIN.padding).toBe(0);
    expect(PLAIN.radius).toBe(0);
    expect(PLAIN.background.kind).toBe('none');
    expect(PLAIN.shadow).toBe(false);
  });

  it('reads a gradient background', () => {
    const s = resolveStyle({ background: { gradient: ['#111', '#222'], padding: 64 } });
    expect(s.background).toEqual({ kind: 'gradient', colors: ['#111', '#222'] });
    expect(s.padding).toBe(64);
  });

  it('reads a solid background', () => {
    const s = resolveStyle({ background: { color: '#0a0a0f', padding: 20 } });
    expect(s.background).toEqual({ kind: 'solid', color: '#0a0a0f' });
  });

  it('prefers a gradient when both are given', () => {
    const s = resolveStyle({ background: { gradient: ['#1', '#2'], color: '#3' } });
    expect(s.background.kind).toBe('gradient');
  });

  it('reads window radius and shadow', () => {
    const s = resolveStyle({ window: { radius: 12, shadow: true } });
    expect(s.radius).toBe(12);
    expect(s.shadow).toBe(true);
  });

  it('reads cursor size', () => {
    expect(resolveStyle({ cursor: { size: 1.5 } }).cursorSize).toBeCloseTo(1.5, 3);
  });

  it('defaults cursor size to 1 when unset', () => {
    expect(resolveStyle({ window: { radius: 4 } }).cursorSize).toBe(1);
  });

  it('gives padding a sensible default when a background is set without one', () => {
    // A background with zero padding would be invisible.
    const s = resolveStyle({ background: { gradient: ['#1', '#2'] } });
    expect(s.padding).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/style.test.ts`
Expected: FAIL — cannot resolve `./style.js`.

- [ ] **Step 3: Implement**

Create `src/render/style.ts`:

```ts
import type { DemoScript } from '../schema/demo.js';

export type ResolvedBackground =
  | { kind: 'none' }
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; colors: string[] };

export interface ResolvedStyle {
  background: ResolvedBackground;
  padding: number;
  radius: number;
  shadow: boolean;
  /** Multiplier on the drawn cursor. */
  cursorSize: number;
}

/**
 * What a demo with no `style:` block gets.
 *
 * Deliberately inert: an existing demo must render exactly as it did
 * before this phase, so every value here is a no-op.
 */
export const PLAIN: ResolvedStyle = {
  background: { kind: 'none' },
  padding: 0,
  radius: 0,
  shadow: false,
  cursorSize: 1,
};

/** Padding used when a background is requested without one. */
const DEFAULT_PADDING = 48;

export function resolveStyle(style: DemoScript['style']): ResolvedStyle {
  if (!style) return PLAIN;

  const bg = style.background;
  let background: ResolvedBackground = { kind: 'none' };
  if (bg?.gradient && bg.gradient.length >= 2) {
    background = { kind: 'gradient', colors: [...bg.gradient] };
  } else if (bg?.color) {
    background = { kind: 'solid', color: bg.color };
  }

  const hasBackground = background.kind !== 'none';
  const padding = bg?.padding ?? (hasBackground ? DEFAULT_PADDING : 0);

  return {
    background,
    padding,
    radius: style.window?.radius ?? 0,
    shadow: style.window?.shadow ?? false,
    cursorSize: style.cursor?.size ?? 1,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/style.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/style.ts src/render/style.test.ts
git commit -m "feat: resolve the style block, inert when absent"
```

---

### Task 2: The presentation pass

**Files:**
- Create: `src/render/present.ts`
- Test: `src/render/present.test.ts`

**Interfaces:**
- Consumes: `ResolvedStyle` (Task 1)
- Produces:
  - `class Presenter` with `constructor(width, height, style)`, `present(source: Canvas): Buffer`, `get isPlain(): boolean`

`present` draws the composed frame inset by the padding, rounded and
shadowed, over the background. When the style is plain it returns the
source pixels untouched — no allocation, no copy, no change.

- [ ] **Step 1: Write the failing test**

Create `src/render/present.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { Presenter } from './present.js';
import { PLAIN, resolveStyle } from './style.js';

const W = 320;
const H = 180;

function solid(colour: string, w = W, h = H) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  return c;
}

const styled = resolveStyle({
  background: { gradient: ['#101018', '#202038'], padding: 24 },
  window: { radius: 10, shadow: true },
});

describe('Presenter', () => {
  it('returns a buffer of the right size', () => {
    const p = new Presenter(W, H, styled);
    expect(p.present(solid('#ff0000')).length).toBe(W * H * 4);
  });

  it('is a pass-through when the style is plain', () => {
    const p = new Presenter(W, H, PLAIN);
    const src = solid('#ff0000');
    const out = p.present(src);
    expect(Buffer.compare(out, Buffer.from(src.data()))).toBe(0);
    expect(p.isPlain).toBe(true);
  });

  it('changes the frame when styled', () => {
    const src = solid('#ff0000');
    const plain = new Presenter(W, H, PLAIN).present(src);
    const fancy = new Presenter(W, H, styled).present(src);
    expect(Buffer.compare(plain, fancy)).not.toBe(0);
  });

  it('paints background in the padding, not source content', () => {
    const p = new Presenter(W, H, styled);
    const out = p.present(solid('#ff0000'));
    // Top-left corner is padding, so it must not be the source red.
    expect(out[0]!).toBeLessThan(120);
  });

  it('keeps the source visible in the middle', () => {
    const p = new Presenter(W, H, styled);
    const out = p.present(solid('#ff0000'));
    const mid = (H / 2) * W * 4 + (W / 2) * 4;
    expect(out[mid]!).toBeGreaterThan(180);
  });

  it('rounds the corners of the inset content', () => {
    const rounded = new Presenter(W, H, styled).present(solid('#ff0000'));
    const square = new Presenter(
      W,
      H,
      resolveStyle({ background: { gradient: ['#101018', '#202038'], padding: 24 } }),
    ).present(solid('#ff0000'));
    // Same padding, different radius, so the corner pixels differ.
    expect(Buffer.compare(rounded, square)).not.toBe(0);
  });

  it('is deterministic', () => {
    const p = new Presenter(W, H, styled);
    const src = solid('#00ff00');
    expect(Buffer.compare(p.present(src), p.present(src))).toBe(0);
  });

  it('handles a solid background', () => {
    const p = new Presenter(W, H, resolveStyle({ background: { color: '#123456', padding: 20 } }));
    const out = p.present(solid('#ff0000'));
    expect(out[0]!).toBeCloseTo(0x12, -1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/present.test.ts`
Expected: FAIL — cannot resolve `./present.js`.

- [ ] **Step 3: Implement**

Create `src/render/present.ts`:

```ts
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { ResolvedStyle } from './style.js';

/**
 * Wraps the composed frame in a presentation frame.
 *
 * Entirely a compositor pass: it never touches capture, never changes
 * timing, and re-renders without re-running anything (spec section 7.2).
 */
export class Presenter {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly style: ResolvedStyle,
  ) {
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
  }

  /** True when this presenter would leave a frame unchanged. */
  get isPlain(): boolean {
    return (
      this.style.background.kind === 'none' &&
      this.style.padding === 0 &&
      this.style.radius === 0 &&
      !this.style.shadow
    );
  }

  present(source: Canvas): Buffer {
    // A demo without style: must be byte-identical to before this phase,
    // so do not even copy through the canvas.
    if (this.isPlain) return Buffer.from(source.data());

    const { ctx, width, height, style } = this;

    if (style.background.kind === 'gradient') {
      const g = ctx.createLinearGradient(0, 0, width, height);
      const colors = style.background.colors;
      colors.forEach((c, i) => g.addColorStop(i / Math.max(1, colors.length - 1), c));
      ctx.fillStyle = g;
    } else if (style.background.kind === 'solid') {
      ctx.fillStyle = style.background.color;
    } else {
      ctx.fillStyle = '#000000';
    }
    ctx.fillRect(0, 0, width, height);

    const pad = style.padding;
    const w = Math.max(1, width - pad * 2);
    const h = Math.max(1, height - pad * 2);

    if (style.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = Math.max(12, pad * 0.7);
      ctx.shadowOffsetY = Math.max(4, pad * 0.25);
      ctx.fillStyle = '#000000';
      roundedPath(ctx, pad, pad, w, h, style.radius);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    roundedPath(ctx, pad, pad, w, h, style.radius);
    ctx.clip();
    ctx.drawImage(source, pad, pad, w, h);
    ctx.restore();

    return Buffer.from(this.canvas.data());
  }
}

function roundedPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/present.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/present.ts src/render/present.test.ts
git commit -m "feat: presentation pass with background, padding, rounding and shadow"
```

---

### Task 3: Cursor position under page scale

**Files:**
- Modify: `src/backends/browser/session.ts`
- Modify: `src/render/cursor.ts`
- Modify: `src/render/browser-frame.ts`
- Test: `src/render/cursor.test.ts`

**Interfaces:**
- `BrowserSession` gains `zoomTrack(): Array<{ tSec: number; scale: number }>`; `setZoom` records an entry
- `cursor.ts` gains `scaleAt(track, tSec): number`
- `composeBrowserWithCursor` gains a `zoomTrack` parameter and multiplies cursor coordinates by the scale in effect

Phase 2 shipped a known bug: keyframes are CSS pixels, so once a scene
zooms the pointer is drawn where it never was.

- [ ] **Step 1: Write the failing test**

Append to `src/render/cursor.test.ts`:

```ts
import { scaleAt } from './cursor.js';

describe('scaleAt', () => {
  const track = [
    { tSec: 0, scale: 1 },
    { tSec: 2, scale: 1.8 },
  ];

  it('is 1 before any zoom', () => {
    expect(scaleAt(track, 1)).toBe(1);
  });

  it('takes the most recent scale', () => {
    expect(scaleAt(track, 2.5)).toBeCloseTo(1.8, 6);
  });

  it('is 1 for an empty track', () => {
    expect(scaleAt([], 5)).toBe(1);
  });

  it('never interpolates between scales', () => {
    // The browser jumps to the new scale; a blended value would put the
    // cursor somewhere the page never rendered.
    expect(scaleAt(track, 1.999)).toBe(1);
  });
});
```

Append to `src/render/browser-frame.test.ts`:

```ts
describe('cursor under page scale', () => {
  const geometry = { width: 640, height: 360 };
  const pointers: CursorKeyframe[] = [{ tSec: 0, at: { x: 100, y: 80 }, click: true }];

  it('draws the cursor in a different place once the page has zoomed', async () => {
    const path = jpeg('zoomed.jpg', '#ffffff');

    const unzoomed = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(unzoomed, path, pointers, 1, []);

    const zoomed = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(zoomed, path, pointers, 1, [{ tSec: 0, scale: 1.8 }]);

    // Keyframes are CSS pixels; under a page scale the pointer belongs
    // somewhere else entirely.
    expect(Buffer.compare(unzoomed.readPixels(), zoomed.readPixels())).not.toBe(0);
  });

  it('is unchanged when no zoom was applied', async () => {
    const path = jpeg('unzoomed.jpg', '#ffffff');
    const a = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(a, path, pointers, 1, []);
    const b = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(b, path, pointers, 1, [{ tSec: 0, scale: 1 }]);
    expect(Buffer.compare(a.readPixels(), b.readPixels())).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/render/cursor.test.ts src/render/browser-frame.test.ts`
Expected: FAIL — `scaleAt` missing; `composeBrowserWithCursor` takes four arguments.

- [ ] **Step 3: Implement**

In `src/render/cursor.ts`:

```ts
export interface ZoomKeyframe {
  tSec: number;
  scale: number;
}

/**
 * The page scale in effect at a moment.
 *
 * Never interpolated: the browser jumps to a new scale, so a blended
 * value would place the cursor over a page state that never rendered.
 */
export function scaleAt(track: readonly ZoomKeyframe[], tSec: number): number {
  let scale = 1;
  for (const k of track) {
    if (k.tSec <= tSec) scale = k.scale;
    else break;
  }
  return scale;
}
```

In `src/render/browser-frame.ts`, extend the helper:

```ts
export async function composeBrowserWithCursor(
  renderer: BrowserFrameRenderer,
  jpegPath: string | null,
  pointers: readonly CursorKeyframe[],
  tSec: number,
  zoomTrack: readonly ZoomKeyframe[] = [],
): Promise<void> {
  await renderer.compose(jpegPath);
  const cursor = cursorAt([...pointers], tSec);
  if (!cursor) return;
  // Keyframes are CSS pixels. Once the page is scaled, the same element
  // sits somewhere else on screen.
  const scale = scaleAt(zoomTrack, tSec);
  drawCursor(
    renderer.context,
    { x: cursor.at.x * scale, y: cursor.at.y * scale },
    { clickAge: cursor.clickAge },
  );
}
```

In `src/backends/browser/session.ts`, record zooms:

```ts
  const zoomTrack: ZoomKeyframe[] = [];
```

```ts
    async setZoom(scale) {
      await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: scale });
      zoomTrack.push({ tSec: Date.now() / 1000, scale });
    },

    zoomTrack: () => [...zoomTrack],
```

Add `zoomTrack(): ZoomKeyframe[]` to the interface, collect it in
`captureDemo` alongside `pointers` as `zooms`, and pass it through both
render paths, rebased by the manifest's first frame time exactly as
pointers are.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/render/ src/backends/browser/ src/driver/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/cursor.ts src/render/browser-frame.ts src/backends/browser/session.ts src/driver/ src/render/cursor.test.ts src/render/browser-frame.test.ts
git commit -m "fix: scale cursor coordinates with the page zoom"
```

---

### Task 4: Wire presentation into the render

**Files:**
- Modify: `src/driver/render.ts`
- Modify: `fixtures/flagship/demo.yaml`
- Test: `src/driver/render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/driver/render.test.ts`:

```ts
describe('presentation', () => {
  it('renders a styled demo and a plain one to different videos', async () => {
    const plain = load('fixtures/flagship/demo.yaml');
    delete (plain as { style?: unknown }).style;

    const outPlain = join(dir, 'plain.mp4');
    const reportPlain = await renderDemo(plain, { outputPath: outPlain });
    expect(reportPlain.ok, JSON.stringify(reportPlain.scenes, null, 2)).toBe(true);

    const styled = load('fixtures/flagship/demo.yaml');
    const outStyled = join(dir, 'styled.mp4');
    const reportStyled = await renderDemo(styled, { outputPath: outStyled });
    expect(reportStyled.ok).toBe(true);

    // Same canvas contract either way — presentation is a compositor
    // pass, not a resolution change.
    const a = await probeVideo(outPlain);
    const b = await probeVideo(outStyled);
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
    expect(statSync(outStyled).size).not.toBe(statSync(outPlain).size);
  }, 600000);
});
```

Import `statSync` from `node:fs` at the top.

- [ ] **Step 2: Add a style block to the flagship**

In `fixtures/flagship/demo.yaml`, after `defaults:`:

```yaml
style:
  background: { gradient: ["#0f1020", "#1b1b33"], padding: 56 }
  window: { radius: 14, shadow: true }
  cursor: { size: 1.4 }
```

- [ ] **Step 3: Implement**

In `src/driver/render.ts`:

```ts
import { Presenter } from '../render/present.js';
import { resolveStyle } from '../render/style.js';
```

Create one presenter per render:

```ts
  const presenter = new Presenter(canvasW, canvasH, resolveStyle(script.style));
```

Then replace every `yield <compositor>.readPixels()` with a presented
frame. For the composed path:

```ts
        yield presenter.present(compositor.surface);
```

For the terminal path, `renderer.compose(screen)` then
`yield presenter.present(renderer.surface)`. For the browser path,
`composeBrowserWithCursor(...)` then `yield presenter.present(browserRenderer.surface)`.

Pass `style.cursorSize` into `drawCursor` via `composeBrowserWithCursor`
so `style.cursor.size` takes effect.

- [ ] **Step 4: Run the suite**

```bash
npx vitest run
npm run typecheck
npm run build
```

- [ ] **Step 5: Render and LOOK**

```bash
node dist/cli/index.js render fixtures/flagship/demo.yaml --out docs/flagship-demo.mp4
```

Confirm: the content floats on a gradient with rounded corners and a
shadow; the terminal and browser are both inset consistently; the inset
in the final scene still reads; the cursor sits on the elements it
clicks.

- [ ] **Step 6: Commit**

```bash
git add src/driver/render.ts src/driver/render.test.ts fixtures/flagship/demo.yaml docs/flagship-demo.mp4
git commit -m "feat: apply the presentation frame to every rendered demo"
```

---

## Phase 5a Definition of Done

- `npx vitest run` all green; typecheck and build clean.
- A demo with no `style:` renders exactly as it did before this phase.
- A styled demo shows a gradient background, padding, rounded corners and a drop shadow, at the same canvas size.
- The cursor is drawn in the right place after a scene zooms.
- The flagship carries a `style:` block and looks postable.

**Not in this plan (Phase 5b):** auto-zoom framing to a bounding box, spring easing, and motion blur.
