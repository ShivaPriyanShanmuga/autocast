import { describe, it, expect } from 'vitest';
import { stretchFor, checkSync, STRETCH_LIMIT, ACTION_FLOOR_SEC } from './sync.js';

describe('stretchFor', () => {
  it('does not touch audio that already fits', () => {
    expect(stretchFor(2, 3)).toBe(1);
    expect(stretchFor(3, 3)).toBe(1);
  });

  it('speeds audio up rather than slowing the video, within the limit', () => {
    // Deviation 1 from spec 7.1: a pitch-preserved 5% stretch is
    // inaudible, holding a scene 5% longer is visible.
    expect(stretchFor(3.15, 3)).toBeCloseTo(1.05, 3);
  });

  it('clamps at the audible limit instead of mangling the voice', () => {
    expect(stretchFor(10, 3)).toBeCloseTo(1 + STRETCH_LIMIT, 5);
  });

  it('leaves audio alone when there is no action to fit it to', () => {
    // An assertions-only scene has nothing for narration to outrun, so
    // squeezing the voice would be pointless.
    expect(stretchFor(4, 0)).toBe(1);
  });
});

describe('checkSync', () => {
  const scene = (id: string, narrationSec: number, actionSec: number) => ({
    id,
    narrationSec,
    actionSec,
  });

  it('says nothing when narration fits inside the action', () => {
    expect(checkSync([scene('boot', 2, 4)], 'strict')).toEqual([]);
  });

  it('says nothing when the overrun is inside the stretch limit', () => {
    // 5% over is absorbed by speeding the audio, so the video never
    // stretched and there is nothing to report.
    expect(checkSync([scene('boot', 3.15, 3)], 'strict')).toEqual([]);
  });

  it('reports a scene whose pacing is being driven by words, in strict mode', () => {
    // Deviation 2 from spec 7.1: audio can no longer overflow, because
    // the 7.1.1 floor always makes room. The failure worth having is
    // that the video is being held open for narration.
    const findings = checkSync([scene('boot', 9, 3)], 'strict');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.scene).toBe('boot');
    expect(findings[0]!.detail).toMatch(/narration/i);
  });

  it('stays quiet about the same scene in hold mode', () => {
    expect(checkSync([scene('boot', 9, 3)], 'hold')).toEqual([]);
  });

  it('exempts a scene with no action of its own', () => {
    // The flagship's `proof` scene is assertions only. Holding it for
    // narration is the ONLY thing that could set its length, so calling
    // that a sync failure would fail every well-formed demo.
    expect(checkSync([scene('proof', 3.2, 0)], 'strict')).toEqual([]);
  });

  it('exempts a scene whose action is a rounding error, not just exactly zero', () => {
    // Measured on the flagship: an assertions-only scene reports 0.001s,
    // because evaluating an assertion still takes a moment. An
    // exact-zero exemption let it through and then reported that
    // narration was holding open a scene with nothing in it.
    expect(checkSync([scene('logs', 1.83, 0.001)], 'strict')).toEqual([]);
    expect(stretchFor(1.83, 0.001)).toBe(1);
  });

  it('still checks a scene doing real work just above the floor', () => {
    const justAbove = ACTION_FLOOR_SEC + 0.01;
    expect(checkSync([scene('a', justAbove * 5, justAbove)], 'strict')).toHaveLength(1);
  });

  it('reports every offending scene, not just the first', () => {
    expect(
      checkSync([scene('a', 9, 3), scene('b', 2, 5), scene('c', 12, 4)], 'strict'),
    ).toHaveLength(2);
  });
});
