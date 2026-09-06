import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { wrapCaption, drawCaption, MAX_LINES } from './caption.js';

describe('wrapCaption', () => {
  it('returns nothing for empty text', () => {
    expect(wrapCaption('', 40)).toEqual([]);
    expect(wrapCaption('   ', 40)).toEqual([]);
  });

  it('keeps short text on one line', () => {
    expect(wrapCaption('And the server logged it.', 40)).toEqual(['And the server logged it.']);
  });

  it('wraps on word boundaries', () => {
    const lines = wrapCaption('A customer places an order for twenty-four units.', 30);
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
    expect(lines.join(' ')).toBe('A customer places an order for twenty-four units.');
  });

  it('never exceeds the line limit', () => {
    const long = Array.from({ length: 60 }, () => 'word').join(' ');
    expect(wrapCaption(long, 20).length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('marks truncation rather than silently dropping text', () => {
    // Losing half a sentence with no sign is worse than an ellipsis: the
    // viewer cannot tell the caption is incomplete.
    const long = Array.from({ length: 60 }, () => 'word').join(' ');
    expect(wrapCaption(long, 20).join('')).toMatch(/…$/);
  });

  it('does not loop forever on a word longer than the line', () => {
    const lines = wrapCaption('supercalifragilisticexpialidocious', 10);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('collapses newlines, which would otherwise break the layout', () => {
    expect(wrapCaption('one\ntwo', 40)).toEqual(['one two']);
  });
});

describe('drawCaption', () => {
  const W = 400;
  const H = 240;

  /** Fill a canvas, draw a caption on it, return its pixels. */
  function render(lines: string[], background: string): Buffer {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    drawCaption(ctx, lines, { width: W, height: H });
    return Buffer.from(canvas.data());
  }

  /** Mean luminance of a horizontal band, as a fraction of the height. */
  function bandLuma(px: Buffer, from: number, to: number): number {
    let sum = 0;
    let n = 0;
    for (let y = Math.round(H * from); y < Math.round(H * to); y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        sum += 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
        n++;
      }
    }
    return sum / n;
  }

  it('draws in the lower third and leaves the top half alone', () => {
    const before = render([], '#ffffff');
    const after = render(['And the server logged it.'], '#ffffff');
    expect(bandLuma(after, 0, 0.5)).toBeCloseTo(bandLuma(before, 0, 0.5), 5);
    expect(bandLuma(after, 0.66, 1)).not.toBeCloseTo(bandLuma(before, 0.66, 1), 1);
  });

  it('draws nothing at all for an empty caption', () => {
    const blank = render([], '#ffffff');
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    expect(Buffer.compare(blank, Buffer.from(canvas.data()))).toBe(0);
  });

  it('stays legible over a white page AND a dark terminal', () => {
    // The whole reason for a scrim rather than outlined text: the caption
    // has to survive both, and our demos cut between exactly these two.
    const onWhite = render(['A customer places an order.'], '#ffffff');
    const onDark = render(['A customer places an order.'], '#101014');
    // The scrim darkens white and lightens near-black, so the text has
    // something to contrast against either way.
    expect(bandLuma(onWhite, 0.66, 1)).toBeLessThan(bandLuma(render([], '#ffffff'), 0.66, 1));
    expect(bandLuma(onDark, 0.66, 1)).toBeGreaterThan(bandLuma(render([], '#101014'), 0.66, 1));
  });

  it('gives two lines more vertical room than one', () => {
    const one = render(['one line'], '#ffffff');
    const two = render(['first line', 'second line'], '#ffffff');
    // The two-line scrim reaches higher up the frame.
    const strip = (px: Buffer): number => bandLuma(px, 0.6, 0.7);
    expect(strip(two)).toBeLessThan(strip(one));
  });
});
