import type { SceneCapture } from '../driver/capture.js';
import type { DemoScript } from '../schema/demo.js';

export interface InsetSpec {
  session: string;
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  scale: number;
}

export interface SceneWindow {
  id: string;
  /** The acting session — whose steps and assertions ran. */
  use: string;
  outStartSec: number;
  outEndSec: number;
  /** Wall-clock span actually captured; may be shorter than the window. */
  wallStartMs: number;
  wallEndMs: number;
  /** Session shown fullscreen. */
  primary: string;
  inset: InsetSpec | null;
}

export interface CompositionPlan {
  windows: SceneWindow[];
  totalSec: number;
}

/**
 * Shortest time any scene occupies. A scene whose work is all assertions
 * measures zero duration — the flagship's `logs` scene came out at 0.00s
 * in the spike — and without a floor it would flash by in one frame.
 */
export const MIN_SCENE_SEC = 1.2;

/**
 * A beat held on every scene's end state before cutting away.
 *
 * `wait_for` returns the INSTANT its pattern matches, so a scene that
 * waits for `listening on :3000` ends on the very frame that text
 * appears — the viewer never gets to read the thing the scene was about.
 * The tail freezes on the captured end state (see `wallClockAt`), it does
 * not invent footage.
 */
export const SCENE_TAIL_SEC = 0.9;

export interface PlanOptions {
  minSceneSec?: number;
  sceneTailSec?: number;
}

export function planComposition(
  script: DemoScript,
  scenes: SceneCapture[],
  opts: PlanOptions = {},
): CompositionPlan {
  const minSceneSec = opts.minSceneSec ?? MIN_SCENE_SEC;
  const sceneTailSec = opts.sceneTailSec ?? SCENE_TAIL_SEC;
  const sessionIds = new Set(Object.keys(script.sessions));
  const byId = new Map(scenes.map((s) => [s.id, s]));

  const windows: SceneWindow[] = [];
  let cursor = 0;

  for (const scene of script.scenes) {
    if (!sessionIds.has(scene.use)) {
      throw new Error(`scene "${scene.id}" uses session "${scene.use}", which is not declared`);
    }

    const captured = byId.get(scene.id);
    const wallStartMs = captured?.startedAt ?? 0;
    const wallEndMs = captured?.endedAt ?? wallStartMs;
    const measuredSec = Math.max(0, (wallEndMs - wallStartMs) / 1000);
    const durationSec = Math.max(measuredSec, minSceneSec) + sceneTailSec;

    const primary = scene.layout?.primary ?? scene.use;
    if (!sessionIds.has(primary)) {
      throw new Error(
        `scene "${scene.id}" has layout.primary "${primary}", which is not declared`,
      );
    }

    const inset = scene.layout?.inset ?? null;
    if (inset && !sessionIds.has(inset.session)) {
      throw new Error(
        `scene "${scene.id}" has layout.inset.session "${inset.session}", which is not declared`,
      );
    }

    windows.push({
      id: scene.id,
      use: scene.use,
      outStartSec: cursor,
      outEndSec: cursor + durationSec,
      wallStartMs,
      wallEndMs,
      primary,
      inset,
    });
    cursor += durationSec;
  }

  return { windows, totalSec: cursor };
}

/**
 * Map a point on the output timeline back to wall-clock time.
 *
 * Inside a scene, wall time advances 1:1 until the scene's measured
 * duration runs out, then FREEZES for the remainder of the hold. Holding
 * shows the captured end state; extrapolating would invent footage that
 * was never recorded.
 */
export function wallClockAt(
  plan: CompositionPlan,
  outSec: number,
): { window: SceneWindow; wallMs: number } | null {
  if (outSec < 0 || outSec > plan.totalSec) return null;

  const window =
    plan.windows.find((w) => outSec >= w.outStartSec && outSec < w.outEndSec) ??
    plan.windows[plan.windows.length - 1];
  if (!window) return null;

  const intoSec = outSec - window.outStartSec;
  const measuredMs = window.wallEndMs - window.wallStartMs;
  const offsetMs = Math.min(intoSec * 1000, measuredMs);

  return { window, wallMs: window.wallStartMs + offsetMs };
}
