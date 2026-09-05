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

describe('crossfade', () => {
  const W = 320;
  const H = 180;

  it('snapshot then full fade reproduces the snapshotted frame', () => {
    const c = new LayoutCompositor(W, H, DEFAULT_THEME);
    c.clear();
    c.drawFullscreen(solid(W, H, '#ff0000'));
    c.snapshot();

    c.clear();
    c.drawFullscreen(solid(W, H, '#0000ff'));
    c.fadeInPrevious(1);

    // Fully opaque: the outgoing frame wins.
    const px = (H / 2) * W * 4 + (W / 2) * 4;
    const buf = c.readPixels();
    expect(buf[px]!).toBeGreaterThan(200);
    expect(buf[px + 2]!).toBeLessThan(80);
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
