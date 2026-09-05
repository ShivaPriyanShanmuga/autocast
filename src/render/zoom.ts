import { minimumJerk } from './cursor.js';

/**
 * A spring curve: eases out with a small overshoot, then settles.
 *
 * The overshoot is the point — it is what reads as physical rather than
 * mechanical. Kept small, because a demo zoom that visibly bounces is
 * distracting.
 */
export function spring(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const decay = Math.exp(-6 * t);
  return 1 - decay * Math.cos(7.5 * t);
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
