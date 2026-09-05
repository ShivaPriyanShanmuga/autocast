import { describe, it, expect } from 'vitest';
import {
  spring,
  planZoom,
  zoomScaleAt,
  ZOOM_IN_SEC,
  ZOOM_HOLD_SEC,
  ZOOM_OUT_SEC,
  ZOOM_SEC,
} from './zoom.js';

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

describe('zoomScaleAt', () => {
  const TARGET = 1.7;

  it('starts and ends at 1', () => {
    expect(zoomScaleAt(0, TARGET)).toBe(1);
    expect(zoomScaleAt(-1, TARGET)).toBe(1);
    expect(zoomScaleAt(ZOOM_SEC, TARGET)).toBe(1);
    expect(zoomScaleAt(ZOOM_SEC + 5, TARGET)).toBe(1);
  });

  it('holds at the target for the whole middle', () => {
    // The hold is the point of zooming at all: it is when the viewer
    // actually reads the thing we moved the camera to.
    expect(zoomScaleAt(ZOOM_IN_SEC + 0.05, TARGET)).toBeCloseTo(TARGET, 5);
    expect(zoomScaleAt(ZOOM_IN_SEC + ZOOM_HOLD_SEC / 2, TARGET)).toBe(TARGET);
    expect(zoomScaleAt(ZOOM_IN_SEC + ZOOM_HOLD_SEC - 0.01, TARGET)).toBe(TARGET);
  });

  it('pulls back out before the scene ends, rather than cutting at full zoom', () => {
    const out = ZOOM_IN_SEC + ZOOM_HOLD_SEC;
    expect(zoomScaleAt(out + ZOOM_OUT_SEC * 0.5, TARGET)).toBeLessThan(TARGET);
    expect(zoomScaleAt(out + ZOOM_OUT_SEC * 0.5, TARGET)).toBeGreaterThan(1);
    expect(zoomScaleAt(out + ZOOM_OUT_SEC * 0.99, TARGET)).toBeCloseTo(1, 1);
  });

  it('never overshoots below 1 on the way out', () => {
    // A spring on the way out would push past 1, which is not "zoomed
    // out" — there is nothing beyond the full frame to show.
    for (let t = ZOOM_IN_SEC + ZOOM_HOLD_SEC; t <= ZOOM_SEC + 0.1; t += 0.01) {
      expect(zoomScaleAt(t, TARGET)).toBeGreaterThanOrEqual(1);
    }
  });

  it('starts from rest instead of snapping into motion', () => {
    // The bug this exists for: the old curve covered 21% of its travel in
    // the first frame, so the camera appeared to be yanked rather than to
    // accelerate. Every frame of the first tenth of a second should be
    // small.
    expect(zoomScaleAt(1 / 30, TARGET) - 1).toBeLessThan(0.02);
    expect(zoomScaleAt(2 / 30, TARGET) - 1).toBeLessThan(0.06);
  });

  it('moves smoothly at 30fps, with no step big enough to read as a jump', () => {
    let prev = zoomScaleAt(0, TARGET);
    let biggest = 0;
    for (let t = 1 / 30; t <= ZOOM_SEC; t += 1 / 30) {
      const s = zoomScaleAt(t, TARGET);
      biggest = Math.max(biggest, Math.abs(s - prev));
      prev = s;
    }
    // Some frame has to be the fastest; what matters is that it is not a
    // discontinuity. Three times the average travel per frame is motion,
    // ten times is a jump.
    expect(biggest).toBeLessThan(0.07);
  });

  it('keeps the overshoot small enough not to read as a bounce', () => {
    let peak = 0;
    for (let t = 0; t <= ZOOM_IN_SEC; t += 0.005) peak = Math.max(peak, zoomScaleAt(t, TARGET));
    expect(peak).toBeLessThan(TARGET * 1.03);
  });
});
