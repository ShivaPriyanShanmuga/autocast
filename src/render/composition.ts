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
   * `focus:` for a scene whose primary is a terminal. Terminal zoom is
   * compositor-side (we render the grid offline), so unlike browser zoom
   * it is applied at render time and is losslessly re-renderable.
   */
  terminalFocus: string | null;
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

/**
 * A frozen lead-in at the start of every scene but the first, holding
 * its opening state while the crossfade from the previous scene runs.
 *
 * Without it, idle compression races ahead DURING the fade: a browser
 * session that has been capturing since before its scene opens with a
 * large idle gap, which compresses 8x, so a 0.35s fade covered several
 * seconds of page activity and the two scenes appeared smeared together
 * rather than handed over.
 *
 * MUST equal TRANSITION_SEC in layout.ts — a test asserts it.
 */
export const SCENE_HEAD_SEC = 0.35;

/** Which sessions are terminals, so a focus can be routed correctly. */
export type TerminalSessions = ReadonlySet<string>;

export interface PlanOptions {
  minSceneSec?: number;
  sceneTailSec?: number;
  sceneHeadSec?: number;
  /** Idle spans per scene id, in absolute wall-clock ms. */
  idleByScene?: Record<string, IdleSpan[]>;
  maxSpeedup?: number;
  terminalSessions?: TerminalSessions;
}

export function planComposition(
  script: DemoScript,
  scenes: SceneCapture[],
  opts: PlanOptions = {},
): CompositionPlan {
  const minSceneSec = opts.minSceneSec ?? MIN_SCENE_SEC;
  const sceneTailSec = opts.sceneTailSec ?? SCENE_TAIL_SEC;
  const sceneHeadSec = opts.sceneHeadSec ?? SCENE_HEAD_SEC;
  const sessionIds = new Set(Object.keys(script.sessions));
  const byId = new Map(scenes.map((s) => [s.id, s]));

  const windows: SceneWindow[] = [];
  let cursor = 0;

  for (const [sceneIndex, scene] of script.scenes.entries()) {
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

    // Nothing fades into the first scene, so it needs no head.
    const headSec = sceneIndex === 0 ? 0 : sceneHeadSec;
    if (headSec > 0) {
      segments.push({
        outStartSec: outCursor,
        outEndSec: outCursor + headSec,
        wallStartMs,
        wallEndMs: wallStartMs,
      });
      outCursor += headSec;
    }

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

    const compressedSec = outCursor - cursor - headSec;
    // The minimum applies to the compressed body. The tail is added on
    // top and is NEVER compressed: it exists so a scene's result can be
    // read, and eating it would undo that.
    const bodySec = Math.max(compressedSec, minSceneSec);
    if (bodySec > compressedSec) {
      // Pad by holding the end state, exactly as the tail does.
      segments.push({
        outStartSec: outCursor,
        outEndSec: cursor + headSec + bodySec,
        wallStartMs: wallEndMs,
        wallEndMs,
      });
    }
    const durationSec = headSec + bodySec + sceneTailSec;

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
      terminalFocus:
        opts.terminalSessions?.has(primary) && typeof scene.focus === 'string'
          ? scene.focus
          : null,
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

/**
 * How far into a scene's uncompressed tail an output time sits, 0..1.
 *
 * Terminal zoom animates across the tail: the tail exists precisely so a
 * scene's result can be read, which is exactly when a zoom onto that
 * result belongs.
 */
export function tailProgress(window: SceneWindow, outSec: number): number {
  const lastSegment = window.segments[window.segments.length - 1];
  const bodyEnd = lastSegment?.outEndSec ?? window.outStartSec;
  const tail = window.outEndSec - bodyEnd;
  if (tail <= 0) return outSec >= bodyEnd ? 1 : 0;
  return Math.max(0, Math.min(1, (outSec - bodyEnd) / tail));
}
