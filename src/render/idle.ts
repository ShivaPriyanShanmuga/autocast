import type { FrameManifest } from '../backends/browser/frame-store.js';
import type { CastLog } from '../backends/terminal/cast.js';

/** A stretch of wall-clock time in which nothing happened. */
export interface IdleSpan {
  startMs: number;
  endMs: number;
}

/**
 * Gaps shorter than this read as natural rhythm, not dead air. Anything
 * longer is a candidate for compression.
 */
export const IDLE_THRESHOLD_MS = 700;

/** Spec section 7.1 lever 1: a long wait becomes brief, never instant. */
export const MAX_SPEEDUP = 8;

function gapsToSpans(timesMs: number[], thresholdMs: number): IdleSpan[] {
  const spans: IdleSpan[] = [];
  for (let i = 1; i < timesMs.length; i++) {
    const startMs = timesMs[i - 1]!;
    const endMs = timesMs[i]!;
    if (endMs - startMs > thresholdMs) spans.push({ startMs, endMs });
  }
  return spans;
}

/** Idle is simply the gap between one cast event and the next. */
export function castIdleSpans(cast: CastLog, thresholdMs = IDLE_THRESHOLD_MS): IdleSpan[] {
  return gapsToSpans(
    cast.events.map((e) => cast.startedAtMs + e[0] * 1000),
    thresholdMs,
  );
}

/**
 * Idle is the gap between one captured frame and the next.
 *
 * No pixel diffing is needed: the screencast only emits on repaint
 * (spec section 4.5.1), so a gap already means nothing changed. Spec
 * section 7.1 describes a delta threshold, which is a more expensive
 * route to the same answer.
 */
export function manifestIdleSpans(
  manifest: FrameManifest,
  thresholdMs = IDLE_THRESHOLD_MS,
): IdleSpan[] {
  return gapsToSpans(
    manifest.frames.map((f) => f.tSec * 1000),
    thresholdMs,
  );
}

/** Intersect spans with a window, dropping anything that survives empty. */
export function clampSpans(
  spans: readonly IdleSpan[],
  startMs: number,
  endMs: number,
): IdleSpan[] {
  const out: IdleSpan[] = [];
  for (const span of spans) {
    const s = Math.max(span.startMs, startMs);
    const e = Math.min(span.endMs, endMs);
    if (e > s) out.push({ startMs: s, endMs: e });
  }
  return out;
}
