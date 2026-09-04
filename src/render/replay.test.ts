import { describe, it, expect } from 'vitest';
import type { CastLog } from '../backends/terminal/cast.js';
import { replayCast, frameCount } from './replay.js';
import type { ScreenState } from './screen.js';

function cast(events: Array<[number, string]>, width = 20, height = 4): CastLog {
  return {
    version: 2,
    width,
    height,
    timestamp: 0,
    events: events.map(([t, d]) => [t, 'o', d]),
  };
}

const collect = async (c: CastLog, fps: number, tailMs = 0) => {
  const out: ScreenState[] = [];
  for await (const s of replayCast(c, { fps, tailMs })) out.push(s);
  return out;
};

const rowText = (s: ScreenState, row: number) =>
  s.cells[row]!.map((c) => c.char).join('').trimEnd();

describe('frameCount', () => {
  it('covers the full duration at the given rate', () => {
    expect(frameCount(cast([[0, 'a'], [1, 'b']]), 30, 0)).toBe(30);
  });

  it('includes the tail hold', () => {
    expect(frameCount(cast([[0, 'a'], [1, 'b']]), 30, 1000)).toBe(60);
  });

  it('never returns zero for an empty cast', () => {
    expect(frameCount(cast([]), 30, 0)).toBeGreaterThan(0);
  });
});

describe('replayCast', () => {
  it('yields exactly frameCount frames', async () => {
    const c = cast([[0, 'a'], [1, 'b']]);
    const frames = await collect(c, 10);
    expect(frames).toHaveLength(frameCount(c, 10, 0));
  });

  it('applies events as their timestamps pass', async () => {
    const c = cast([[0.0, 'first'], [0.5, '\r\nsecond']]);
    const frames = await collect(c, 10);
    expect(rowText(frames[1]!, 0)).toBe('first');
    expect(rowText(frames[1]!, 1)).toBe('');
    expect(rowText(frames[frames.length - 1]!, 1)).toBe('second');
  });

  it('carries the terminal geometry into every frame', async () => {
    const frames = await collect(cast([[0, 'x']], 30, 5), 5);
    for (const f of frames) {
      expect(f.cols).toBe(30);
      expect(f.rows).toBe(5);
    }
  });

  it('resolves a carriage-return redraw to the final value', async () => {
    const c = cast([[0, 'p  10%'], [0.2, '\rp 100%']]);
    const frames = await collect(c, 10);
    expect(rowText(frames[frames.length - 1]!, 0)).toBe('p 100%');
  });

  it('holds the last state through the tail', async () => {
    const c = cast([[0, 'done']]);
    const frames = await collect(c, 10, 500);
    expect(frames.length).toBeGreaterThan(4);
    expect(rowText(frames[frames.length - 1]!, 0)).toBe('done');
  });

  it('handles an empty cast without hanging', async () => {
    const frames = await collect(cast([]), 10);
    expect(frames.length).toBeGreaterThan(0);
    expect(rowText(frames[0]!, 0)).toBe('');
  });
});
