import { describe, it, expect } from 'vitest';
import type { CastLog } from '../backends/terminal/cast.js';
import type { FrameManifest } from '../backends/browser/frame-store.js';
import {
  castIdleSpans,
  manifestIdleSpans,
  clampSpans,
  idleThresholdFor,
  IDLE_THRESHOLD_MS,
} from './idle.js';

const EPOCH = 1788570640000;

function cast(times: number[]): CastLog {
  return {
    version: 2,
    width: 80,
    height: 24,
    timestamp: Math.floor(EPOCH / 1000),
    startedAtMs: EPOCH,
    events: times.map((t) => [t, 'o', 'x']),
  };
}

function manifest(times: number[]): FrameManifest {
  return {
    dir: '/tmp/x',
    width: 640,
    height: 400,
    frames: times.map((t, i) => ({ path: `f${i}.jpg`, tSec: EPOCH / 1000 + t })),
  };
}

describe('castIdleSpans', () => {
  it('finds a gap longer than the threshold', () => {
    // Events at 0s and 3s: 3 seconds of nothing in between.
    const spans = castIdleSpans(cast([0, 3]));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startMs).toBeCloseTo(EPOCH, -1);
    expect(spans[0]!.endMs).toBeCloseTo(EPOCH + 3000, -1);
  });

  it('ignores gaps shorter than the threshold', () => {
    expect(castIdleSpans(cast([0, 0.1, 0.2, 0.3]))).toEqual([]);
  });

  it('finds several gaps', () => {
    expect(castIdleSpans(cast([0, 2, 2.1, 5]))).toHaveLength(2);
  });

  it('honours a custom threshold', () => {
    expect(castIdleSpans(cast([0, 0.5]), 200)).toHaveLength(1);
    expect(castIdleSpans(cast([0, 0.5]), 2000)).toEqual([]);
  });

  it('returns nothing for an empty or single-event cast', () => {
    expect(castIdleSpans(cast([]))).toEqual([]);
    expect(castIdleSpans(cast([1]))).toEqual([]);
  });

  it('reports absolute wall-clock times, not relative', () => {
    const spans = castIdleSpans(cast([0, 3]));
    expect(spans[0]!.startMs).toBeGreaterThan(1_000_000_000_000);
  });
});

describe('manifestIdleSpans', () => {
  it('treats a frame gap as idleness, with no pixel diffing', () => {
    // The screencast only emits on repaint, so a gap IS nothing changing.
    const spans = manifestIdleSpans(manifest([0, 3]));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.endMs - spans[0]!.startMs).toBeCloseTo(3000, -1);
  });

  it('ignores short gaps', () => {
    expect(manifestIdleSpans(manifest([0, 0.1, 0.25]))).toEqual([]);
  });

  it('returns nothing for an empty manifest', () => {
    expect(manifestIdleSpans(manifest([]))).toEqual([]);
  });

  it('uses the same default threshold as the terminal', () => {
    const justUnder = (IDLE_THRESHOLD_MS - 50) / 1000;
    const justOver = (IDLE_THRESHOLD_MS + 50) / 1000;
    expect(manifestIdleSpans(manifest([0, justUnder]))).toEqual([]);
    expect(manifestIdleSpans(manifest([0, justOver]))).toHaveLength(1);
  });
});

describe('clampSpans', () => {
  const spans = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 5000, endMs: 9000 },
  ];

  it('drops spans entirely outside the window', () => {
    expect(clampSpans(spans, 3000, 4000)).toEqual([]);
  });

  it('keeps spans entirely inside', () => {
    expect(clampSpans(spans, 0, 10000)).toHaveLength(2);
  });

  it('trims a span that straddles the start', () => {
    const [first] = clampSpans(spans, 1500, 10000);
    expect(first!.startMs).toBe(1500);
    expect(first!.endMs).toBe(2000);
  });

  it('trims a span that straddles the end', () => {
    const result = clampSpans(spans, 0, 6000);
    expect(result[1]!.endMs).toBe(6000);
  });

  it('drops a span trimmed to nothing', () => {
    expect(clampSpans([{ startMs: 1000, endMs: 1000 }], 0, 5000)).toEqual([]);
  });
});

describe('idleThresholdFor', () => {
  it('never classifies a deliberate settle pause as dead air', () => {
    // The bug this exists to prevent: with settle at 750ms and a fixed
    // 700ms threshold, EVERY intentional pause was compressed 8x, which
    // silently undid the pacing the script asked for.
    const settleMs = 750;
    const threshold = idleThresholdFor(settleMs);
    expect(threshold).toBeGreaterThan(settleMs);
    expect(castIdleSpans(cast([0, 0.75]), threshold)).toEqual([]);
  });

  it('still compresses waits meaningfully longer than the settle', () => {
    const threshold = idleThresholdFor(750);
    expect(castIdleSpans(cast([0, 4]), threshold)).toHaveLength(1);
  });

  it('falls back to the floor when settle is small', () => {
    expect(idleThresholdFor(100)).toBe(IDLE_THRESHOLD_MS);
    expect(idleThresholdFor(0)).toBe(IDLE_THRESHOLD_MS);
  });

  it('scales with a larger settle', () => {
    expect(idleThresholdFor(2000)).toBeGreaterThan(idleThresholdFor(750));
  });
});
