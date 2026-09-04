import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME } from './theme.js';
import { fitGeometry, FrameRenderer } from './frame.js';
import type { ScreenState, RenderedCell } from './screen.js';

function cell(over: Partial<RenderedCell> = {}): RenderedCell {
  return {
    char: ' ',
    width: 1,
    fg: DEFAULT_THEME.foreground,
    bg: DEFAULT_THEME.background,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    ...over,
  };
}

function screen(rows: string[], cols = 20): ScreenState {
  return {
    cols,
    rows: rows.length,
    cells: rows.map((line) =>
      Array.from({ length: cols }, (_, x) => cell({ char: line[x] ?? ' ' })),
    ),
  };
}

describe('fitGeometry', () => {
  it('fits the grid inside the canvas', () => {
    const g = fitGeometry(90, 24, 1280, 720);
    expect(g.width).toBe(1280);
    expect(g.height).toBe(720);
    expect(g.fontSizePx).toBeGreaterThan(4);
  });

  it('uses a smaller font for a wider grid', () => {
    const wide = fitGeometry(200, 24, 1280, 720);
    const narrow = fitGeometry(60, 24, 1280, 720);
    expect(wide.fontSizePx).toBeLessThan(narrow.fontSizePx);
  });
});

describe('FrameRenderer', () => {
  const geometry = fitGeometry(20, 3, 320, 180);

  it('returns an RGBA buffer of exactly width * height * 4', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const buf = r.render(screen(['hello', '', '']));
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
  });

  it('paints the theme background', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const buf = r.render(screen(['', '', '']));
    // Top-left pixel sits in the padding, so it is pure background.
    const expected = DEFAULT_THEME.background;
    expect(buf[0]).toBe(parseInt(expected.slice(1, 3), 16));
    expect(buf[1]).toBe(parseInt(expected.slice(3, 5), 16));
    expect(buf[2]).toBe(parseInt(expected.slice(5, 7), 16));
  });

  it('draws glyphs — a frame with text differs from an empty one', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const empty = r.render(screen(['', '', '']));
    const text = r.render(screen(['hello world', '', '']));
    expect(Buffer.compare(empty, text)).not.toBe(0);
  });

  it('is deterministic for the same input', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const a = r.render(screen(['same', '', '']));
    const b = r.render(screen(['same', '', '']));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('does not leak the previous frame when content shrinks', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const blank = r.render(screen(['', '', '']));
    r.render(screen(['XXXXXXXXXX', 'YYYYYYYYYY', 'ZZZZZZZZZZ']));
    const blankAgain = r.render(screen(['', '', '']));
    expect(Buffer.compare(blank, blankAgain)).toBe(0);
  });

  it('skips width-0 continuation cells without double drawing', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const wide: ScreenState = {
      cols: 20,
      rows: 3,
      cells: [
        [cell({ char: '漢', width: 2 }), cell({ char: ' ', width: 0 })].concat(
          Array.from({ length: 18 }, () => cell()),
        ),
        Array.from({ length: 20 }, () => cell()),
        Array.from({ length: 20 }, () => cell()),
      ],
    };
    expect(() => r.render(wide)).not.toThrow();
  });
});
