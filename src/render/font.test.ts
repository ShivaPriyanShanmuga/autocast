import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { FONT_FAMILY, ensureFontRegistered, measureCell } from './font.js';

describe('bundled font', () => {
  it('registers under a stable family name', () => {
    ensureFontRegistered();
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = `20px "${FONT_FAMILY}"`;
    expect(ctx.measureText('M').width).toBeGreaterThan(0);
  });

  it('is genuinely monospaced, unlike the generic family', () => {
    ensureFontRegistered();
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = `20px "${FONT_FAMILY}"`;
    const widths = ['M', 'i', 'W', '.', 'l', '@'].map((c) => ctx.measureText(c).width);
    expect(new Set(widths.map((w) => w.toFixed(3))).size).toBe(1);
  });

  it('is idempotent', () => {
    ensureFontRegistered();
    expect(() => ensureFontRegistered()).not.toThrow();
  });

  it('reports cell metrics proportional to the font size', () => {
    const a = measureCell(16);
    const b = measureCell(32);
    expect(b.cellWidth).toBeCloseTo(a.cellWidth * 2, 1);
    expect(a.cellHeight).toBeGreaterThan(a.cellWidth);
    expect(a.fontSpec).toContain(FONT_FAMILY);
  });
});
