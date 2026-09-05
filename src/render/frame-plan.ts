import { tailProgress, wallClockAt, type CompositionPlan, type SceneWindow } from './composition.js';
import { TRANSITION_SEC } from './layout.js';
import { spring } from './zoom.js';

export interface FramePlan {
  window: SceneWindow;
  /** Wall-clock instant the sources should be advanced to. */
  wallMs: number;
  /** Camera zoom for this frame. 1 when this window does not zoom. */
  zoom: number;
  /**
   * True on the first frame of a new window: the finished frame still on
   * the canvas belongs to the outgoing scene and must be kept before it
   * is overwritten.
   */
  cut: boolean;
  /** How strongly the outgoing scene still shows, 0..1. */
  fadeAlpha: number;
}

/**
 * Everything a single output frame needs, decided in one place.
 *
 * This exists because it did not. Zoom was handled on its own branch of
 * the frame loop, and that branch yielded its frame without ever running
 * the crossfade — so a cut into or out of any zooming scene was hard,
 * while every other cut blended. Deciding zoom and fade together makes
 * that class of bug unrepresentable: there is no path that computes one
 * without the other.
 */
export function planFrame(
  plan: CompositionPlan,
  outSec: number,
  previousWindowId: string | null,
  zoomScale: number,
): FramePlan | null {
  const at = wallClockAt(plan, outSec);
  if (!at) return null;

  const zoom = at.window.focus
    ? Math.max(1, 1 + (zoomScale - 1) * spring(tailProgress(at.window, outSec)))
    : 1;

  const intoScene = outSec - at.window.outStartSec;
  const fadeAlpha =
    previousWindowId !== null && intoScene < TRANSITION_SEC
      ? Math.max(0, Math.min(1, 1 - intoScene / TRANSITION_SEC))
      : 0;

  return {
    window: at.window,
    wallMs: at.wallMs,
    zoom,
    cut: previousWindowId !== null && previousWindowId !== at.window.id,
    fadeAlpha,
  };
}
