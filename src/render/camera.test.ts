import { describe, it, expect } from 'vitest';
import { cameraRect, cellRectToPixels } from './camera.js';
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
