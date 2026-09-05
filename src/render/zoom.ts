import { minimumJerk } from './cursor.js';

/**
 * A spring curve: accelerates from rest, overshoots slightly, settles.
 *
 * The overshoot is the point — it is what reads as physical rather than
 * mechanical. Kept small, because a demo zoom that visibly bounces is
 * distracting.
 *
 * Starting from REST is what the first version got wrong. `1 - e^-6t
 * cos(7.5t)` leaves zero at full speed: at 30fps its first frame covered
 * 21% of the travel, so a camera driven by it snapped into motion and
 * then bounced 11% past its target. This is the standard damped
 * second-order step response, which has zero initial velocity by
 * construction, tuned to about 1.5% overshoot and settled inside t=1.
 */
const DECAY = 5;
const FREQ = 3.75;

export function spring(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-DECAY * t) * (Math.cos(FREQ * t) + (DECAY / FREQ) * Math.sin(FREQ * t));
}

export interface ZoomStep {
  scale: number;
  /** How long to hold this scale before the next one. */
  delayMs: number;
}

export interface PlanZoomOptions {
  steps?: number;
  durationMs?: number;
  ease?: 'spring' | 'cubic';
}

/**
 * Steps default to one per output frame.
 *
 * Browser zoom is capture-side: each step repaints and the screencast
 * emits a frame. With fewer steps than output frames the resampler holds
 * each captured frame across several ticks, and the zoom visibly steps.
 */
const OUTPUT_FPS = 30;
/**
 * 420ms read as hurried: a zoom is a change of attention, and the eye
 * needs longer to follow it than a cursor needs to cross the screen.
 */
const DEFAULT_DURATION_MS = 800;

export function planZoom(from: number, to: number, opts: PlanZoomOptions = {}): ZoomStep[] {
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const count = Math.max(1, opts.steps ?? Math.ceil((durationMs / 1000) * OUTPUT_FPS));
  const ease = opts.ease === 'cubic' ? minimumJerk : spring;

  if (Math.abs(to - from) < 1e-6) return [{ scale: to, delayMs: 0 }];

  const delayMs = Math.max(1, Math.round(durationMs / count));
  const steps: ZoomStep[] = [];

  for (let i = 0; i < count; i++) {
    const t = (i + 1) / count;
    // Land exactly on `to`: an eased curve that overshoots must still
    // finish at the requested scale, or the cursor track and the page
    // disagree about where things are.
    const p = i === count - 1 ? 1 : ease(t);
    steps.push({ scale: Math.max(0.01, from + (to - from) * p), delayMs });
  }

  return steps;
}

/**
 * How long a zoom takes to arrive, how long it stays, and how long it
 * takes to leave.
 *
 * The camera used to ride the scene's tail and finish at full zoom, so
 * the scene cut away the instant it arrived. That is backwards: arriving
 * is not the point, reading what we arrived at is. And leaving at full
 * zoom means the crossfade is doing the pulling-back, which reads as a
 * jump rather than as a camera move.
 */
export const ZOOM_IN_SEC = 1.2;
export const ZOOM_HOLD_SEC = 1.4;
export const ZOOM_OUT_SEC = 0.9;
export const ZOOM_SEC = ZOOM_IN_SEC + ZOOM_HOLD_SEC + ZOOM_OUT_SEC;

/**
 * Smooth at both ends, no overshoot.
 *
 * A cosine rather than a cubic: the cubic's midpoint is three times its
 * average speed, which at 30fps put an 0.08 jump in the middle of the
 * pull-back. A cosine peaks at 1.57x average and reads as a glide.
 */
function easeInOut(t: number): number {
  return (1 - Math.cos(Math.PI * t)) / 2;
}

/**
 * Camera scale this far into a scene's zoom.
 *
 * In on a spring, because arriving somewhere should feel physical. Out
 * on a plain ease, because a spring on the way out would push past 1,
 * and there is nothing beyond the full frame to show.
 */
export function zoomScaleAt(elapsedSec: number, target: number): number {
  const travel = Math.max(0, target - 1);
  if (elapsedSec <= 0 || travel === 0) return 1;

  if (elapsedSec < ZOOM_IN_SEC) {
    return Math.max(1, 1 + travel * spring(elapsedSec / ZOOM_IN_SEC));
  }
  const held = elapsedSec - ZOOM_IN_SEC;
  if (held < ZOOM_HOLD_SEC) return target;

  const out = (held - ZOOM_HOLD_SEC) / ZOOM_OUT_SEC;
  if (out >= 1) return 1;
  return Math.max(1, 1 + travel * (1 - easeInOut(out)));
}
