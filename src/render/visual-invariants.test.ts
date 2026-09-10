import { describe, it, expect } from 'vitest';
import {
  spring,
  zoomScaleAt,
  ZOOM_IN_SEC,
  ZOOM_HOLD_SEC,
  ZOOM_OUT_SEC,
  ZOOM_SEC,
} from './zoom.js';
import { browserRectToPixels, cameraRect, zoomedCamera } from './camera.js';
import { captionLineChars, wrapCaption, MAX_LINES } from './caption.js';
import { speechDurationSec, DEFAULT_WPM } from './speech.js';
import { insetRect, TRANSITION_SEC } from './layout.js';
import { MIN_SCENE_SEC, SCENE_HEAD_SEC, SCENE_TAIL_SEC } from './composition.js';
import { idleThresholdFor, MAX_SPEEDUP } from './idle.js';

/**
 * A golden master over everything that decides how the video LOOKS.
 *
 * These numbers were measured from a build whose output was reviewed and
 * accepted. They are not derived, and there is no clever way to satisfy
 * them: they exist so that a refactor, a "harmless" tidy-up, or a bug fix
 * somewhere adjacent cannot quietly restyle every demo in the repo.
 *
 * The render path is deterministic given its inputs — capture timing
 * varies run to run, but none of the maths below touches a clock — so
 * freezing exact values is honest rather than flaky.
 *
 * If a change here is INTENDED, update the numbers in the same commit
 * that changes the behaviour, and say in the message what a viewer will
 * see differently. If a change here is a surprise, it is a bug.
 */
describe('the look of the video is frozen', () => {
  it('pacing constants', () => {
    expect({
      ZOOM_IN_SEC,
      ZOOM_HOLD_SEC,
      ZOOM_OUT_SEC,
      TRANSITION_SEC,
      MIN_SCENE_SEC,
      SCENE_TAIL_SEC,
      SCENE_HEAD_SEC,
      MAX_SPEEDUP,
      MAX_LINES,
      DEFAULT_WPM,
    }).toEqual({
      ZOOM_IN_SEC: 1.2,
      ZOOM_HOLD_SEC: 1.4,
      ZOOM_OUT_SEC: 0.9,
      TRANSITION_SEC: 0.5,
      MIN_SCENE_SEC: 2,
      SCENE_TAIL_SEC: 1.3,
      SCENE_HEAD_SEC: 0.5,
      MAX_SPEEDUP: 8,
      MAX_LINES: 2,
      DEFAULT_WPM: 150,
    });
    expect(ZOOM_SEC).toBeCloseTo(3.5, 9);
  });

  it('the easing curve', () => {
    const at = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1].map((t) =>
      Number(spring(t).toFixed(6)),
    );
    expect(at).toEqual([0, 0.13794, 0.517004, 0.801881, 0.910457, 0.969288, 1.001442, 1.003532, 1]);
  });

  it('the zoom envelope', () => {
    const at = [0, 0.3, 0.6, 0.9, 1.2, 1.9, 2.6, 2.9, 3.2, 3.5].map((t) =>
      Number(zoomScaleAt(t, 1.7).toFixed(6)),
    );
    expect(at).toEqual([1, 1.361903, 1.63732, 1.70101, 1.7, 1.7, 1.7, 1.525, 1.175, 1]);
  });

  it('where the camera sits', () => {
    const surface = { width: 2176, height: 1224 };
    const focus = { x: 400, y: 800, width: 300, height: 40 };
    expect(cameraRect(surface, null, 1)).toEqual({ x: 0, y: 0, width: 2176, height: 1224 });
    expect(cameraRect(surface, focus, 1.7)).toEqual({ x: 0, y: 460, width: 1280, height: 720 });
  });

  it('how the camera travels', () => {
    const surface = { width: 2176, height: 1224 };
    const focus = { x: 400, y: 800, width: 300, height: 40 };
    const path = [0, 0.5, 1].map((p) => {
      const c = zoomedCamera(surface, focus, 1 + 0.7 * p, 1.7);
      return [c.x, c.y, c.width, c.height].map((n) => Number(n.toFixed(6)));
    });
    expect(path).toEqual([
      [0, 0, 2176, 1224],
      [0, 230, 1728, 972],
      [0, 460, 1280, 720],
    ]);
  });

  it('how a page box maps onto the surface', () => {
    expect(
      browserRectToPixels(
        { width: 2176, height: 1224 },
        { width: 1280, height: 720 },
        { x: 100, y: 50, width: 200, height: 80 },
      ),
    ).toEqual({ x: 170, y: 85, width: 340, height: 136 });
  });

  it('caption layout', () => {
    expect(captionLineChars(1280)).toBe(63);
    expect(wrapCaption('And there it is, live in about two seconds.', 63)).toEqual([
      'And there it is, live in about two seconds.',
    ]);
  });

  it('how long narration is assumed to take', () => {
    expect(speechDurationSec('First we start the shipboard server.')).toBeCloseTo(2.4, 6);
    expect(speechDurationSec('And there it is, live in about two seconds.')).toBeCloseTo(3.6, 6);
  });

  it('where an inset window sits', () => {
    expect(insetRect(1280, 720, { session: 'api', corner: 'bottom-right', scale: 0.4 })).toEqual({
      x: 744,
      y: 408,
      width: 512,
      height: 288,
    });
  });

  it('when a pause counts as dead air', () => {
    expect(idleThresholdFor(700)).toBe(1050);
    expect(idleThresholdFor(150)).toBe(700);
  });
});
