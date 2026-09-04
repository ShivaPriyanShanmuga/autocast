import {
  relativeTimeline,
  type FrameManifest,
  type StoredFrame,
} from '../backends/browser/frame-store.js';

export interface ResampleOptions {
  fps: number;
  /** Extra time to hold the final frame so the video does not cut dead. */
  tailMs?: number;
}

export interface ResampledTick {
  index: number;
  /** Seconds from the start of the capture. */
  tSec: number;
  /** null only before the first captured frame exists. */
  source: StoredFrame | null;
}

const DEFAULT_TAIL_MS = 800;

function spanSec(frames: StoredFrame[]): number {
  return frames.length === 0 ? 0 : (frames[frames.length - 1]!.tSec ?? 0);
}

export function browserFrameCount(
  manifest: FrameManifest,
  fps: number,
  tailMs = DEFAULT_TAIL_MS,
): number {
  const total = spanSec(relativeTimeline(manifest)) + tailMs / 1000;
  return Math.max(1, Math.ceil(total * fps));
}

/**
 * Map a fixed-rate timeline onto change-driven capture.
 *
 * The screencast only emits on repaint, so a still page can go seconds
 * without a frame (spec section 4.5.1). Each tick therefore takes the
 * most recent frame whose timestamp has passed — a HOLD, never a blend:
 * interpolating two JPEGs would invent motion the page never made.
 */
export function resampleManifest(
  manifest: FrameManifest,
  opts: ResampleOptions,
): ResampledTick[] {
  const frames = relativeTimeline(manifest);
  const total = browserFrameCount(manifest, opts.fps, opts.tailMs);
  const ticks: ResampledTick[] = [];

  let cursor = -1; // index of the most recent frame whose time has passed

  for (let index = 0; index < total; index++) {
    const tSec = (index + 1) / opts.fps;
    while (cursor + 1 < frames.length && frames[cursor + 1]!.tSec <= tSec) cursor++;
    ticks.push({
      index,
      tSec,
      source: cursor >= 0 ? frames[cursor]! : null,
    });
  }

  return ticks;
}
