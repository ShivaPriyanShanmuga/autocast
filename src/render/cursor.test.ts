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
    drawCursor(plain.getContext('2d'), { x: 40, y: 40 }, {});

    const clicked = createCanvas(80, 80);
    drawCursor(clicked.getContext('2d'), { x: 40, y: 40 }, { clickAge: 0.05 });

    expect(Buffer.compare(Buffer.from(plain.data()), Buffer.from(clicked.data()))).not.toBe(0);
  });

  it('does not throw when drawn off-canvas', () => {
    const canvas = createCanvas(40, 40);
    expect(() => drawCursor(canvas.getContext('2d'), { x: -100, y: 900 }, {})).not.toThrow();
  });
});

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
