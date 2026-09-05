import type { SceneCapture } from '../driver/capture.js';
import type { DemoScript } from '../schema/demo.js';
import { clampSpans, MAX_SPEEDUP, type IdleSpan } from './idle.js';

/** A stretch of output time mapping linearly onto a stretch of wall time. */
export interface TimeSegment {
  outStartSec: number;
  outEndSec: number;
  wallStartMs: number;
  wallEndMs: number;
}

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
  /**
   * Piecewise map from output time to wall time. Active stretches run
   * 1:1; idle stretches are compressed. Always monotonic, because a
   * backwards step would make CastPlayer throw.
   */
  segments: TimeSegment[];
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
  /** Idle spans per scene id, in absolute wall-clock ms. */
  idleByScene?: Record<string, IdleSpan[]>;
  maxSpeedup?: number;
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
    const idle = clampSpans(opts.idleByScene?.[scene.id] ?? [], wallStartMs, wallEndMs);
    const speedup = Math.max(1, opts.maxSpeedup ?? MAX_SPEEDUP);

    // Walk the measured span, emitting an active segment at 1:1 and each
    // idle gap compressed by `speedup`.
    const segments: TimeSegment[] = [];
    let outCursor = cursor;
    let wallCursor = wallStartMs;

    const pushSegment = (wallEnd: number, divisor: number): void => {
      if (wallEnd <= wallCursor) return;
      const outSpan = (wallEnd - wallCursor) / 1000 / divisor;
      segments.push({
        outStartSec: outCursor,
        outEndSec: outCursor + outSpan,
        wallStartMs: wallCursor,
        wallEndMs: wallEnd,
      });
      outCursor += outSpan;
      wallCursor = wallEnd;
    };

    for (const span of idle) {
      pushSegment(span.startMs, 1); // active run before the gap
      pushSegment(span.endMs, speedup); // the gap itself, compressed
    }
    pushSegment(wallEndMs, 1); // whatever is left

    const compressedSec = outCursor - cursor;
    // The minimum applies to the compressed body. The tail is added on
    // top and is NEVER compressed: it exists so a scene's result can be
    // read, and eating it would undo that.
    const bodySec = Math.max(compressedSec, minSceneSec);
    if (bodySec > compressedSec) {
      // Pad by holding the end state, exactly as the tail does.
      segments.push({
        outStartSec: outCursor,
        outEndSec: cursor + bodySec,
        wallStartMs: wallEndMs,
        wallEndMs,
      });
    }
    const durationSec = bodySec + sceneTailSec;

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
      segments,
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

  const segment = window.segments.find(
    (seg) => outSec >= seg.outStartSec && outSec < seg.outEndSec,
  );

  if (segment) {
    const span = segment.outEndSec - segment.outStartSec;
    const progress = span <= 0 ? 1 : (outSec - segment.outStartSec) / span;
    return {
      window,
      wallMs: segment.wallStartMs + progress * (segment.wallEndMs - segment.wallStartMs),
    };
  }

  // Past the last segment: the tail. Freeze on the captured end state.
  return { window, wallMs: window.wallEndMs };
}
