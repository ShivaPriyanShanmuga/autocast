import { describe, it, expect } from 'vitest';
import { planFrame } from './frame-plan.js';
import { TRANSITION_SEC } from './layout.js';
import { ZOOM_IN_SEC, ZOOM_HOLD_SEC, ZOOM_SEC } from './zoom.js';
import type { CompositionPlan, SceneWindow } from './composition.js';

function window(over: Partial<SceneWindow> & { id: string }): SceneWindow {
  const outStartSec = over.outStartSec ?? 0;
  const outEndSec = over.outEndSec ?? outStartSec + 3;
  return {
    use: over.id,
    primary: over.id,
    inset: null,
    focus: null,
    zoomStartSec: null,
    wallStartMs: 0,
    wallEndMs: 1000,
    // Body runs to 1s before the end; that last second is the tail.
    segments: [
      { outStartSec, outEndSec: outEndSec - 1, wallStartMs: 0, wallEndMs: 1000 },
    ],
    ...over,
    outStartSec,
    outEndSec,
  };
}

const plan = (windows: SceneWindow[]): CompositionPlan => ({
  windows,
  totalSec: windows[windows.length - 1]?.outEndSec ?? 0,
});

describe('planFrame', () => {
  const a = window({ id: 'a', outStartSec: 0, outEndSec: 3 });
  const b = window({ id: 'b', outStartSec: 3, outEndSec: 6 });

  it('returns null past the end of the plan', () => {
    expect(planFrame(plan([a]), 99, null, 1.7)).toBeNull();
  });

  it('does not fade at the very first frame of the video', () => {
    const f = planFrame(plan([a, b]), 0.01, null, 1.7)!;
    expect(f.fadeAlpha).toBe(0);
    expect(f.cut).toBe(false);
  });

  it('reports a cut on the frame the window changes', () => {
    expect(planFrame(plan([a, b]), 3.01, 'a', 1.7)!.cut).toBe(true);
    expect(planFrame(plan([a, b]), 3.2, 'b', 1.7)!.cut).toBe(false);
  });

  it('crossfades into a new scene and settles to zero', () => {
    const early = planFrame(plan([a, b]), 3.01, 'a', 1.7)!;
    const mid = planFrame(plan([a, b]), 3 + TRANSITION_SEC / 2, 'b', 1.7)!;
    const after = planFrame(plan([a, b]), 3 + TRANSITION_SEC + 0.01, 'b', 1.7)!;
    expect(early.fadeAlpha).toBeGreaterThan(0.9);
    expect(mid.fadeAlpha).toBeCloseTo(0.5, 1);
    expect(after.fadeAlpha).toBe(0);
  });

  it('crossfades into a ZOOMING scene too', () => {
    // The regression this exists for: zoom used to be handled on its own
    // branch, which yielded its frame without ever running the fade, so
    // every cut into or out of a zooming scene was hard.
    const zb = window({
      id: 'b',
      outStartSec: 3,
      outEndSec: 6,
      focus: { kind: 'terminal', pattern: '/POST/' },
      zoomStartSec: 4,
    });
    const f = planFrame(plan([a, zb]), 3.01, 'a', 1.7);
    expect(f!.fadeAlpha).toBeGreaterThan(0.9);
  });

  it('holds zoom at 1 for a window that does not zoom', () => {
    for (const t of [0.1, 1.5, 2.9]) {
      expect(planFrame(plan([a]), t, 'a', 1.7)!.zoom).toBe(1);
    }
  });

  it('runs the whole zoom envelope, ending back at 1 before the cut', () => {
    // Zoom in, hold long enough to read it, then pull back OUT. Leaving a
    // scene at full zoom made the crossfade do the pulling back, which
    // reads as a jump rather than as a camera move.
    const zoomStartSec = 4;
    const zb = window({
      id: 'b',
      outStartSec: 3,
      outEndSec: zoomStartSec + ZOOM_SEC + 1,
      focus: { kind: 'browser', box: { x: 0, y: 0, width: 10, height: 10 } },
      zoomStartSec,
    });
    const p = plan([a, zb]);
    const at = (t: number) => planFrame(p, t, 'b', 1.7)!.zoom;

    expect(at(3.5)).toBe(1);
    expect(at(zoomStartSec)).toBe(1);
    expect(at(zoomStartSec + ZOOM_IN_SEC + ZOOM_HOLD_SEC / 2)).toBeCloseTo(1.7, 5);
    expect(at(zoomStartSec + ZOOM_SEC)).toBe(1);
    expect(at(zoomStartSec + ZOOM_SEC + 0.5)).toBe(1);
  });

  it('never zooms below 1, whatever the easing does', () => {
    const zb = window({
      id: 'b',
      outStartSec: 3,
      outEndSec: 3 + ZOOM_SEC + 2,
      focus: { kind: 'terminal', pattern: 'x' },
      zoomStartSec: 4,
    });
    const p = plan([a, zb]);
    for (let t = 3; t < 3 + ZOOM_SEC + 2; t += 0.05) {
      expect(planFrame(p, t, 'b', 1.7)!.zoom).toBeGreaterThanOrEqual(1);
    }
  });
});
