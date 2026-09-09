import { join } from 'node:path';
import type { DemoScript } from '../schema/demo.js';
import { evaluateBrowserAssertion } from '../backends/browser/assertions.js';
import type { FrameManifest } from '../backends/browser/frame-store.js';
import { openBrowserSession, type BrowserSession } from '../backends/browser/session.js';
import { executeBrowserStep } from '../backends/browser/steps.js';
import type { CursorKeyframe, ZoomKeyframe } from '../render/cursor.js';
import { evaluateAssertion, type AssertResult } from '../backends/terminal/assertions.js';
import type { CastLog } from '../backends/terminal/cast.js';
import { openTerminalSession, type TerminalSession } from '../backends/terminal/session.js';
import { executeStep, type StepResult } from '../backends/terminal/steps.js';
import { zoomIntentFor } from './zoom-target.js';

export interface SceneCapture {
  id: string;
  steps: StepResult[];
  assertions: AssertResult[];
  ok: boolean;
  startedAt: number;
  endedAt: number;
}

export interface CaptureArtifact {
  scenes: SceneCapture[];
  /** Scene id that stopped the run, or null if it ran to completion. */
  abortedAt: string | null;
  casts: Record<string, CastLog>;
  frames: Record<string, FrameManifest>;
  pointers: Record<string, CursorKeyframe[]>;
  zooms: Record<string, ZoomKeyframe[]>;
  /**
   * Where a browser scene wants to zoom, in CSS pixels, keyed by scene id.
   *
   * Recorded rather than applied: browser zoom is now a compositor camera
   * over the finished frame, so the window and background scale with the
   * content. Zooming inside the browser could only ever scale the page,
   * leaving the frame around it pinned.
   */
  zoomBoxes: Record<string, { x: number; y: number; width: number; height: number }>;
  ok: boolean;
}

export interface CaptureOptions {
  now?: () => number;
  /** Where browser frames are written. */
  framesRoot?: string;
  /**
   * What to do when a scene fails. Spec section 8: abort is the
   * documented default, because later scenes usually fail only BECAUSE
   * an earlier one did, and that cascade buries the real cause.
   */
  onSceneFail?: 'abort' | 'continue';
}

type AnySession =
  | { kind: 'terminal'; id: string; session: TerminalSession }
  | { kind: 'browser'; id: string; session: BrowserSession };

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

export async function captureDemo(
  script: DemoScript,
  opts: CaptureOptions = {},
): Promise<CaptureArtifact> {
  const now = opts.now ?? (() => Date.now());
  const typingSpeedMs = toMs(script.defaults?.typing_speed, 65);
  // 400ms was shorter than the cursor's 0.7s travel, so the pointer
  // never arrived before the next action fired and everything read as
  // rushed. Keep this at or above the cursor travel time.
  const settleMs = toMs(script.defaults?.settle, 750);
  const framesRoot = opts.framesRoot ?? join('.castscript', 'frames');

  // Insertion order is declaration order; teardown reverses it (spec 4.6).
  const sessions: AnySession[] = [];
  const casts: Record<string, CastLog> = {};
  const frames: Record<string, FrameManifest> = {};
  const pointers: Record<string, CursorKeyframe[]> = {};
  const zooms: Record<string, ZoomKeyframe[]> = {};
  const zoomBoxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const scenes: SceneCapture[] = [];
  let abortedAt: string | null = null;

  try {
    for (const [id, config] of Object.entries(script.sessions)) {
      if (config.backend === 'terminal') {
        sessions.push({
          kind: 'terminal',
          id,
          session: await openTerminalSession({
            cols: config.cols ?? 80,
            rows: config.rows ?? 24,
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            ...(config.env === undefined ? {} : { env: config.env }),
            now,
          }),
        });
      } else {
        const session = await openBrowserSession({
          viewport: config.viewport ?? [1280, 720],
          framesDir: join(framesRoot, id),
          ...(config.attach?.cdp === undefined ? {} : { attachCdp: config.attach.cdp }),
        });
        await session.startCapture();
        sessions.push({ kind: 'browser', id, session });
      }
    }

    for (const scene of script.scenes) {
      const entry = sessions.find((s) => s.id === scene.use);
      if (!entry) throw new Error(`scene "${scene.id}" uses unknown session "${scene.use}"`);

      const startedAt = now();
      const steps: StepResult[] = [];
      const assertions: AssertResult[] = [];

      for (const step of scene.steps ?? []) {
        const result =
          entry.kind === 'terminal'
            ? await executeStep(step as Record<string, unknown>, {
                session: entry.session,
                seed: scene.id,
                typingSpeedMs,
                settleMs,
                now,
              })
            : await executeBrowserStep(step as Record<string, unknown>, {
                session: entry.session,
                settleMs,
                now,
                typingSpeedMs,
                seed: scene.id,
              });
        steps.push(result);
        if (!result.ok) break; // a failed step invalidates everything after it
      }

      // Zoom AFTER the steps, not before. A focus target is very often
      // revealed BY the steps — a form that starts hidden, a result that
      // does not exist until submit — so framing it up front would
      // deadlock: the element cannot appear until the steps that make it
      // appear have run.
      const intent = zoomIntentFor(scene, {
        zoomAuto: script.style?.zoom?.auto ?? false,
        zoomOn: script.style?.zoom?.on ?? 'click',
      });

      if (entry.kind === 'browser' && intent) {
        const box = await entry.session.boundingBox(intent.selector);
        if (box === null) {
          // An explicit focus that matches nothing is an authoring error
          // worth reporting. An auto guess that misses is not — the
          // author never asked for it.
          if (intent.source === 'focus') {
            assertions.push({
              name: 'focus',
              ok: false,
              detail:
                `focus selector ${intent.selector} matched no visible element after the ` +
                'scene ran (it may be absent, or present but not rendered)',
            });
          }
        } else {
          // Record where to frame; the compositor does the zooming.
          zoomBoxes[scene.id] = box;
        }
      }

      for (const assertion of scene.assert ?? []) {
        assertions.push(
          entry.kind === 'terminal'
            ? await evaluateAssertion(assertion as Record<string, unknown>, entry.session)
            : await evaluateBrowserAssertion(assertion as Record<string, unknown>, entry.session),
        );
      }

      const ok = steps.every((s) => s.ok) && assertions.every((a) => a.ok);
      scenes.push({
        id: scene.id,
        steps,
        assertions,
        ok,
        startedAt,
        endedAt: now(),
      });

      if (!ok && (opts.onSceneFail ?? 'abort') === 'abort') {
        abortedAt = scene.id;
        break;
      }
    }

    for (const entry of sessions) {
      if (entry.kind === 'terminal') {
        casts[entry.id] = entry.session.cast();
      } else {
        frames[entry.id] = entry.session.manifest();
        pointers[entry.id] = entry.session.pointerTrack();
        zooms[entry.id] = entry.session.zoomTrack();
      }
    }
    return {
      scenes,
      casts,
      frames,
      pointers,
      zooms,
      zoomBoxes,
      abortedAt,
      ok: scenes.every((s) => s.ok),
    };
  } finally {
    // Reverse declaration order, and never let one failure strand another.
    for (const entry of [...sessions].reverse()) {
      if (entry.kind === 'terminal') {
        casts[entry.id] ??= entry.session.cast();
      } else {
        await entry.session.stopCapture().catch(() => undefined);
        frames[entry.id] ??= entry.session.manifest();
        pointers[entry.id] ??= entry.session.pointerTrack();
        zooms[entry.id] ??= entry.session.zoomTrack();
      }
      await entry.session.dispose().catch(() => undefined);
    }
  }
}

/** @deprecated Phase 1 name. Use captureDemo. */
export const captureTerminalDemo = captureDemo;
