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
