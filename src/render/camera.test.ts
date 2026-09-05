import { describe, it, expect } from 'vitest';
import { browserRectToPixels, cameraRect, cellRectToPixels } from './camera.js';
import type { ScreenState } from './screen.js';

const surface = { width: 2560, height: 1440 };
const focus = { x: 400, y: 200, width: 100, height: 40 };

describe('cameraRect', () => {
  it('covers the whole surface at zoom 1', () => {
    const r = cameraRect(surface, focus, 1);
    expect(r).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
  });

  it('halves the covered area at zoom 2', () => {
    const r = cameraRect(surface, focus, 2);
    expect(r.width).toBeCloseTo(1280, 3);
    expect(r.height).toBeCloseTo(720, 3);
  });

  it('centres on the focus', () => {
    const r = cameraRect({ width: 1000, height: 1000 }, { x: 500, y: 500, width: 10, height: 10 }, 2);
    expect(r.x + r.width / 2).toBeCloseTo(505, 3);
    expect(r.y + r.height / 2).toBeCloseTo(505, 3);
  });

  it('clamps to the surface rather than showing empty space', () => {
    const r = cameraRect(surface, { x: 0, y: 0, width: 10, height: 10 }, 2);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('clamps at the far edge too', () => {
    const r = cameraRect(surface, { x: 2550, y: 1430, width: 10, height: 10 }, 2);
    expect(r.x + r.width).toBeLessThanOrEqual(surface.width + 1e-6);
    expect(r.y + r.height).toBeLessThanOrEqual(surface.height + 1e-6);
  });

  it('centres when there is no focus', () => {
    const r = cameraRect(surface, null, 2);
    expect(r.x).toBeCloseTo(640, 3);
  });

  it('moves continuously as zoom changes, with no snapping', () => {
    // The jitter this replaces came from rounding a font size to whole
    // pixels each frame. A rect must vary smoothly.
    const a = cameraRect(surface, focus, 1.40);
    const b = cameraRect(surface, focus, 1.41);
    expect(a.width).not.toBe(b.width);
    expect(Math.abs(a.width - b.width)).toBeLessThan(30);
  });

  it('treats zoom below 1 as 1', () => {
    expect(cameraRect(surface, focus, 0.2).width).toBe(surface.width);
  });
});

describe('cellRectToPixels', () => {
  const geometry = { width: 1000, height: 500, fontSizePx: 16, padding: 20 };
  const screen = { cols: 80, rows: 24, cells: [] } as unknown as ScreenState;

  it('places column 0 row 0 at the padding', () => {
    const r = cellRectToPixels(geometry, screen, { col: 0, row: 0, width: 1, height: 1 });
    expect(r.x).toBeCloseTo(20, 3);
    expect(r.y).toBeCloseTo(20, 3);
  });

  it('advances by one cell per column', () => {
    const a = cellRectToPixels(geometry, screen, { col: 0, row: 0, width: 1, height: 1 });
    const b = cellRectToPixels(geometry, screen, { col: 1, row: 0, width: 1, height: 1 });
    expect(b.x - a.x).toBeCloseTo((1000 - 40) / 80, 3);
  });

  it('scales width with the match length', () => {
    const r = cellRectToPixels(geometry, screen, { col: 0, row: 0, width: 10, height: 1 });
    expect(r.width).toBeCloseTo(((1000 - 40) / 80) * 10, 3);
  });

  it('stays inside the surface for the last cell', () => {
    const r = cellRectToPixels(geometry, screen, { col: 79, row: 23, width: 1, height: 1 });
    expect(r.x + r.width).toBeLessThanOrEqual(geometry.width);
    expect(r.y + r.height).toBeLessThanOrEqual(geometry.height);
  });
});

describe('browserRectToPixels', () => {
  it('maps a CSS box onto a surface of the same aspect ratio', () => {
    const r = browserRectToPixels(
      { width: 1280, height: 720 },
      { width: 640, height: 360 },
      { x: 100, y: 50, width: 200, height: 80 },
    );
    expect(r).toEqual({ x: 200, y: 100, width: 400, height: 160 });
  });

  it('accounts for the letterbox when the aspect ratios differ', () => {
    // A 640x360 page fit into a 400x400 surface scales by 0.625 and sits
    // 87.5px down. The renderer centres it, so the map must too.
    const r = browserRectToPixels(
      { width: 400, height: 400 },
      { width: 640, height: 360 },
      { x: 0, y: 0, width: 64, height: 36 },
    );
    expect(r.x).toBeCloseTo(0, 5);
    expect(r.y).toBeCloseTo(87.5, 5);
    expect(r.width).toBeCloseTo(40, 5);
    expect(r.height).toBeCloseTo(22.5, 5);
  });

  it('scales with a supersampled surface, so the camera sees real pixels', () => {
    const small = browserRectToPixels(
      { width: 1280, height: 720 },
      { width: 1280, height: 720 },
      { x: 10, y: 20, width: 30, height: 40 },
    );
    const big = browserRectToPixels(
      { width: 2560, height: 1440 },
      { width: 1280, height: 720 },
      { x: 10, y: 20, width: 30, height: 40 },
    );
    expect(big.x).toBeCloseTo(small.x * 2, 5);
    expect(big.width).toBeCloseTo(small.width * 2, 5);
  });
});
