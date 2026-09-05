import { describe, it, expect } from 'vitest';
import { spring, planZoom } from './zoom.js';

describe('spring', () => {
  it('is pinned at both ends', () => {
    expect(spring(0)).toBeCloseTo(0, 6);
    expect(spring(1)).toBeCloseTo(1, 6);
  });

  it('overshoots slightly before settling', () => {
    // The overshoot is what separates a spring from an ease-out.
    const samples = Array.from({ length: 40 }, (_, i) => spring(i / 39));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it('settles rather than oscillating away', () => {
    expect(spring(0.95)).toBeGreaterThan(0.9);
    expect(spring(0.95)).toBeLessThan(1.1);
  });

  it('clamps outside 0..1', () => {
    expect(spring(-1)).toBe(0);
    expect(spring(2)).toBe(1);
  });
});

describe('planZoom', () => {
  it('ends exactly at the to scale', () => {
    const steps = planZoom(1, 1.8);
    expect(steps[steps.length - 1]!.scale).toBeCloseTo(1.8, 6);
  });

  it('produces several intermediate scales', () => {
    expect(planZoom(1, 1.8).length).toBeGreaterThan(5);
  });

  it('never emits a scale at or below zero', () => {
    for (const s of planZoom(1, 2)) expect(s.scale).toBeGreaterThan(0);
  });

  it('spreads the requested duration across the steps', () => {
    const steps = planZoom(1, 1.8, { durationMs: 400 });
    const total = steps.reduce((n, s) => n + s.delayMs, 0);
    expect(total).toBeGreaterThan(300);
    expect(total).toBeLessThan(500);
  });

  it('honours a step count', () => {
    expect(planZoom(1, 1.8, { steps: 6 })).toHaveLength(6);
  });

  it('returns a single settled step when there is no change', () => {
    const steps = planZoom(1.8, 1.8);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.scale).toBeCloseTo(1.8, 6);
  });

  it('can zoom back out', () => {
    const steps = planZoom(1.8, 1);
    expect(steps[steps.length - 1]!.scale).toBeCloseTo(1, 6);
  });

  it('cubic easing does not overshoot', () => {
    const steps = planZoom(1, 1.8, { ease: 'cubic' });
    for (const s of steps) expect(s.scale).toBeLessThanOrEqual(1.8 + 1e-6);
  });
});
