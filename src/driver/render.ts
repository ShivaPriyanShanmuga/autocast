import type { DemoScript } from '../schema/demo.js';
import type { CastLog } from '../backends/terminal/cast.js';
import { BrowserFrameRenderer, composeBrowserWithCursor } from '../render/browser-frame.js';
import type { CursorKeyframe, ZoomKeyframe } from '../render/cursor.js';
import { Presenter } from '../render/present.js';
import { resolveStyle } from '../render/style.js';
import type { Canvas } from '@napi-rs/canvas';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectDurationAnomaly,
  scanBrowserText,
  scanTerminalText,
  type Finding,
} from '../verify/heuristics.js';
import { buildReport, writeReport } from '../verify/report.js';
import { writeContactSheet } from '../verify/contact-sheet.js';
import { CastPlayer as CastPlayerForSheet } from '../render/cast-player.js';
import { encodeFrames } from '../render/encoder.js';
import { browserFrameCount, resampleManifest } from '../render/resample.js';
import { CastPlayer } from '../render/cast-player.js';
import { planComposition, wallClockAt, tailProgress } from '../render/composition.js';
import { findInScreen } from '../render/find-in-screen.js';
import { cameraRect, cellRectToPixels, type Rect } from '../render/camera.js';
import { spring } from '../render/zoom.js';
import { LayoutCompositor, TRANSITION_SEC } from '../render/layout.js';
import {
  castIdleSpans,
  manifestIdleSpans,
  idleThresholdFor,
  type IdleSpan,
} from '../render/idle.js';
import { fitGeometry, FrameRenderer } from '../render/frame.js';
import { frameCount, replayCast } from '../render/replay.js';
import { DEFAULT_THEME } from '../render/theme.js';
import { captureDemo } from './capture.js';

export interface RenderReport {
  ok: boolean;
  outputPath: string;
  /** Contact sheet for a failed run, or null. Never read back. */
  contactSheetPath: string | null;
  /** Heuristic findings — failures nobody wrote an assertion for. */
  findings: Finding[];
  /** Where the machine-readable report was written. */
  reportPath: string;
  scenes: Array<{
    id: string;
    ok: boolean;
    assertions: Array<{ name: string; ok: boolean; detail?: string }>;
  }>;
  frames: number;
  durationSec: number;
}

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

export interface RenderOptions {
  outputPath?: string;
}

export async function renderDemo(
  script: DemoScript,
  opts: RenderOptions = {},
): Promise<RenderReport> {
  const outputPath = opts.outputPath ?? script.output.path;
  const [canvasW, canvasH] = script.output.canvas;
  const fps = script.output.fps;

  // More than one session, or any explicit layout, needs the composed
  // path; a single session keeps the simpler phase 1/2 fast paths.
  const needsComposition =
    Object.keys(script.sessions).length > 1 ||
    script.scenes.some((s) => s.layout !== undefined);

  const resolvedStyle = resolveStyle(script.style);
  const presenter = new Presenter(canvasW, canvasH, resolvedStyle);

  const capture = await captureDemo(script);

  const scenes = capture.scenes.map((s) => ({
    id: s.id,
    ok: s.ok,
    assertions: s.assertions.map((a) => ({
      name: a.name,
      ok: a.ok,
      ...(a.detail === undefined ? {} : { detail: a.detail }),
    })),
  }));

  // Heuristics: catch what no assertion predicted. All text-based —
  // the terminal's character grid and the browser's DOM text are exact,
  // so no OCR and no vision model is involved (spec section 8).
  const findings: Finding[] = [];
  for (const scene of script.scenes) {
    const watched = scene.layout?.primary ?? scene.use;
    const cast = capture.casts[watched];
    if (cast) {
      findings.push(...scanTerminalText(scene.id, cast.events.map((e) => e[2]).join('')));
    }
  }
  for (const s2 of capture.scenes) {
    for (const a of s2.assertions) {
      if (!a.ok && a.detail) findings.push(...scanBrowserText(s2.id, a.detail));
    }
  }
  findings.push(
    ...detectDurationAnomaly(
      capture.scenes.map((s2) => ({ id: s2.id, sec: (s2.endedAt - s2.startedAt) / 1000 })),
    ),
  );

  const sceneSecs = capture.scenes.map((s2) => ({
    id: s2.id,
    ok: s2.ok,
    assertions: s2.assertions.map((a) => ({
      name: a.name,
      ok: a.ok,
      ...(a.detail === undefined ? {} : { detail: a.detail }),
    })),
    sec: Number(((s2.endedAt - s2.startedAt) / 1000).toFixed(3)),
  }));

  const finish = async (frames: number, durationSec: number): Promise<string> =>
    writeReport(
      outputPath,
      buildReport({
        ok: capture.ok,
        scenes: sceneSecs,
        findings,
        abortedAt: capture.abortedAt,
        frames,
        durationSec,
      }),
    );

  if (!capture.ok) {
    // Never hand back a plausible-looking video of a broken demo, and
    // never leave an older good one sitting at the output path where it
    // would be mistaken for this run's result.
    await rm(outputPath, { force: true });

    // Sample the failing scene so a human has something to look at. The
    // path is reported and never opened (spec section 3 constraint 2).
    const failing = capture.scenes.find((s2) => !s2.ok);
    let contactSheetPath: string | null = null;
    if (failing) {
      try {
        const shots = await sampleFailingScene(capture, script, failing, canvasW, canvasH);
        if (shots.length > 0) {
          contactSheetPath = await writeContactSheet(
            join('.autocast', 'failed', `${failing.id}-contact.png`),
            shots,
            { width: canvasW, height: canvasH },
          );
        }
      } catch {
        // A contact sheet is a diagnostic nicety; never let it mask the
        // real failure it is describing.
      }
    }

    const reportPath = await finish(0, 0);
    return {
      ok: false,
      outputPath,
      scenes,
      findings,
      reportPath,
      contactSheetPath,
      frames: 0,
      durationSec: 0,
    };
  }

  if (needsComposition) {
    // Detect idle on the session the viewer is actually watching — a
    // scene's `primary`, which is not always its acting session.
    // Only compress waits longer than the script's own settle: a settle
    // is deliberate pacing, and compressing it undoes what the author asked
    // for.
    const settleMs = toMs(script.defaults?.settle, 750);
    const idleThreshold = idleThresholdFor(settleMs);

    const idleBySession: Record<string, IdleSpan[]> = {};
    for (const [id, cast] of Object.entries(capture.casts)) {
      idleBySession[id] = castIdleSpans(cast, idleThreshold);
    }
    for (const [id, manifest] of Object.entries(capture.frames)) {
      idleBySession[id] = manifestIdleSpans(manifest, idleThreshold);
    }
    const idleByScene: Record<string, IdleSpan[]> = {};
    for (const sc of script.scenes) {
      idleByScene[sc.id] = idleBySession[sc.layout?.primary ?? sc.use] ?? [];
    }

    const terminalSessions = new Set(
      Object.entries(script.sessions)
        .filter(([, cfg]) => cfg.backend === 'terminal')
        .map(([id]) => id),
    );
    const plan = planComposition(script, capture.scenes, { idleByScene, terminalSessions });
    const compositor = new LayoutCompositor(canvasW, canvasH, DEFAULT_THEME);

    // One live source per session, all advanced in lockstep so a layout
    // can call on either at any frame.
    const zoomedTerminals = new Set(
      plan.windows.filter((w) => w.terminalFocus).map((w) => w.primary),
    );
    const zoomTarget = script.style?.zoom?.scale ?? 1.8;

    const players = new Map<string, CastPlayer>();
    const terminalRenderers = new Map<string, FrameRenderer>();
    for (const [id, cast] of Object.entries(capture.casts)) {
      players.set(id, new CastPlayer(cast, DEFAULT_THEME));
      // Render at the zoom factor so the camera has real pixels to crop
      // into; a demo that never zooms this terminal pays nothing.
      const ss = zoomedTerminals.has(id) ? zoomTarget : 1;
      terminalRenderers.set(
        id,
        new FrameRenderer(
          fitGeometry(cast.width, cast.height, Math.round(canvasW * ss), Math.round(canvasH * ss)),
          DEFAULT_THEME,
        ),
      );
    }

    const browsers = new Map<string, BrowserFrameRenderer>();
    const browserTicks = new Map<string, ReturnType<typeof resampleManifest>>();
    const browserPointers = new Map<string, CursorKeyframe[]>();
    const browserZooms = new Map<string, ZoomKeyframe[]>();
    for (const [id, manifest] of Object.entries(capture.frames)) {
      browsers.set(
        id,
        new BrowserFrameRenderer({ width: canvasW, height: canvasH }, DEFAULT_THEME),
      );
      browserTicks.set(id, resampleManifest(manifest, { fps, tailMs: 0 }));
      // Pointer and zoom keyframes are absolute unix seconds; rebase onto
      // the session's own timeline once, not per frame.
      const firstSec = manifest.frames[0]?.tSec ?? 0;
      browserPointers.set(
        id,
        (capture.pointers[id] ?? []).map((k) => ({ ...k, tSec: k.tSec - firstSec })),
      );
      browserZooms.set(
        id,
        (capture.zooms[id] ?? []).map((k) => ({ ...k, tSec: k.tSec - firstSec })),
      );
    }

    /** Draw one session's state at a wall-clock instant onto its canvas. */
    const surfaceFor = async (
      sessionId: string,
      wallMs: number,
      terminalZoom?: { pattern: string; progress: number },
    ): Promise<{ surface: Canvas; camera?: Rect }> => {
      const player = players.get(sessionId);
      if (player) {
        const cast = capture.casts[sessionId]!;
        const tSec = Math.max(0, (wallMs - cast.startedAtMs) / 1000);
        // Forward-only; a hold can ask for the same instant repeatedly.
        if (tSec >= player.position) await player.advanceTo(tSec);
        const renderer = terminalRenderers.get(sessionId)!;
        const screen = player.screen();
        renderer.compose(screen);

        if (!terminalZoom) return { surface: renderer.surface };

        // Move a camera over the already-rendered surface. Sub-pixel and
        // smooth, where re-rendering at a rounded font size jittered.
        const eased = 1 + (zoomTarget - 1) * spring(terminalZoom.progress);
        const cell = findInScreen(screen, terminalZoom.pattern);
        const focus = cell ? cellRectToPixels(renderer.geometry, screen, cell) : null;
        return {
          surface: renderer.surface,
          camera: cameraRect(renderer.geometry, focus, eased),
        };
      }

      const manifest = capture.frames[sessionId];
      const browser = browsers.get(sessionId);
      if (!manifest || !browser) {
        throw new Error(`no captured source for session "${sessionId}"`);
      }
      const firstSec = manifest.frames[0]?.tSec ?? 0;
      const tSec = Math.max(0, wallMs / 1000 - firstSec);
      const ticks = browserTicks.get(sessionId)!;
      // Last tick whose time has passed; hold it otherwise (spec 4.5.1).
      let chosen = ticks[0] ?? null;
      for (const tick of ticks) {
        if (tick.tSec <= tSec) chosen = tick;
        else break;
      }
      await composeBrowserWithCursor(
        browser,
        chosen?.source?.path ?? null,
        browserPointers.get(sessionId) ?? [],
        tSec,
        browserZooms.get(sessionId) ?? [],
        resolvedStyle.cursorSize,
        resolvedStyle.motionBlurCursor,
      );
      return { surface: browser.surface };
    };

    const totalFrames = Math.max(1, Math.ceil(plan.totalSec * fps));

    let previousWindowId: string | null = null;

    async function* composedFrames(): AsyncGenerator<Buffer> {
      for (let i = 0; i < totalFrames; i++) {
        const outSec = (i + 0.5) / fps;
        const at = wallClockAt(plan, outSec);
        if (!at) continue;

        // Snapshot BEFORE clearing: on the frame the window changes, the
        // canvas still holds the outgoing scene's final frame.
        if (previousWindowId !== null && previousWindowId !== at.window.id) {
          compositor.snapshot();
        }

        compositor.clear();
        const termZoom = at.window.terminalFocus
          ? { pattern: at.window.terminalFocus, progress: tailProgress(at.window, outSec) }
          : undefined;
        const primary = await surfaceFor(at.window.primary, at.wallMs, termZoom);
        compositor.drawFullscreen(primary.surface, primary.camera);
        if (at.window.inset) {
          const inset = await surfaceFor(at.window.inset.session, at.wallMs);
          compositor.drawInset(inset.surface, at.window.inset, resolvedStyle.radius);
        }
        // Fade the outgoing scene out over the first moments of this one.
        const intoScene = outSec - at.window.outStartSec;
        if (previousWindowId !== null && intoScene < TRANSITION_SEC) {
          compositor.fadeInPrevious(1 - intoScene / TRANSITION_SEC);
        }

        previousWindowId = at.window.id;
        yield presenter.present(compositor.surface);
      }
    }

    const encoded = await encodeFrames(composedFrames(), {
      width: canvasW,
      height: canvasH,
      fps,
      outputPath,
    });

    const reportPath = await finish(encoded.frames, Number(plan.totalSec.toFixed(2)));
    return {
      ok: scenes.every((s) => s.ok),
      outputPath,
      scenes,
      findings,
      reportPath,
      contactSheetPath: null,
      frames: encoded.frames,
      durationSec: Number(plan.totalSec.toFixed(2)),
    };
  }

  const frameIds = Object.keys(capture.frames);
  if (frameIds.length > 0) {
    const id = frameIds[0]!;
    const manifest = capture.frames[id]!;
    const firstFrameSec = manifest.frames[0]?.tSec ?? 0;

    // Pointer keyframes are absolute unix seconds; ticks are relative to
    // the first captured frame. Rebase once, not per tick.
    const pointers = (capture.pointers[id] ?? []).map((k) => ({
      ...k,
      tSec: k.tSec - firstFrameSec,
    }));
    const zooms = (capture.zooms[id] ?? []).map((k) => ({
      ...k,
      tSec: k.tSec - firstFrameSec,
    }));

    const ticks = resampleManifest(manifest, { fps });
    const browserRenderer = new BrowserFrameRenderer(
      { width: canvasW, height: canvasH },
      DEFAULT_THEME,
    );

    async function* browserFrames(): AsyncGenerator<Buffer> {
      for (const tick of ticks) {
        await composeBrowserWithCursor(
          browserRenderer,
          tick.source?.path ?? null,
          pointers,
          tick.tSec,
          zooms,
          resolvedStyle.cursorSize,
          resolvedStyle.motionBlurCursor,
        );
        yield presenter.present(browserRenderer.surface);
      }
    }

    const encoded = await encodeFrames(browserFrames(), {
      width: canvasW,
      height: canvasH,
      fps,
      outputPath,
    });

    const durationSec = Number((browserFrameCount(manifest, fps) / fps).toFixed(2));
    const reportPath = await finish(encoded.frames, durationSec);
    return {
      ok: scenes.every((s) => s.ok),
      outputPath,
      scenes,
      findings,
      reportPath,
      contactSheetPath: null,
      frames: encoded.frames,
      durationSec,
    };
  }

  const casts = Object.values(capture.casts) as CastLog[];
  const cast = casts[0];
  if (!cast) throw new Error('capture produced no session log to render');

  const geometry = fitGeometry(cast.width, cast.height, canvasW, canvasH);
  const renderer = new FrameRenderer(geometry, DEFAULT_THEME);
  const total = frameCount(cast, fps);

  async function* frames(): AsyncGenerator<Buffer> {
    for await (const screen of replayCast(cast!, { fps, theme: DEFAULT_THEME })) {
      renderer.compose(screen);
      yield presenter.present(renderer.surface);
    }
  }

  const { frames: written } = await encodeFrames(frames(), {
    width: geometry.width,
    height: geometry.height,
    fps,
    outputPath,
  });

  const durationSec = Number((total / fps).toFixed(2));
  const reportPath = await finish(written, durationSec);
  return {
    ok: scenes.every((s) => s.ok),
    outputPath,
    scenes,
    findings,
    reportPath,
    contactSheetPath: null,
    frames: written,
    durationSec,
  };
}

export function formatRenderReport(report: RenderReport): string {
  const lines = [`autocast render — ${report.outputPath}`, ''];

  for (const scene of report.scenes) {
    lines.push(
      `  ${scene.ok ? 'OK  ' : 'FAIL'}  ${scene.id.padEnd(12)}  ${scene.assertions.length} assertions`,
    );
    for (const a of scene.assertions) {
      if (a.ok) continue;
      lines.push(`          assert ${a.name} — ${a.detail ?? 'failed'}`);
    }
  }

  for (const f of report.findings ?? []) {
    lines.push(`  note  ${f.code}  ${f.scene}: ${f.detail}`);
  }

  lines.push('');
  lines.push(`  ${report.frames} frames, ${report.durationSec}s`);
  if (report.reportPath) lines.push(`  report: ${report.reportPath}`);
  if (report.contactSheetPath) {
    lines.push(`  contact sheet: ${report.contactSheetPath}   (not read automatically)`);
  }
  lines.push('');
  lines.push(
    report.ok
      ? `OK — ${report.scenes.length} of ${report.scenes.length} scenes`
      : `FAILED — ${report.scenes.filter((s) => !s.ok).length} of ${report.scenes.length} scenes`,
  );

  return lines.join('\n');
}

/**
 * Compose a handful of frames spread across a failing scene.
 *
 * Kept separate from the render paths because it runs only on failure,
 * and must never be able to break the reporting of the failure itself.
 */
async function sampleFailingScene(
  capture: Awaited<ReturnType<typeof captureDemo>>,
  script: DemoScript,
  failing: { id: string; startedAt: number; endedAt: number },
  canvasW: number,
  canvasH: number,
): Promise<Buffer[]> {
  const scene = script.scenes.find((s) => s.id === failing.id);
  if (!scene) return [];
  const watched = scene.layout?.primary ?? scene.use;
  const shots: Buffer[] = [];
  const COUNT = 6;

  const cast = capture.casts[watched];
  if (cast) {
    const player = new CastPlayerForSheet(cast, DEFAULT_THEME);
    const renderer = new FrameRenderer(
      fitGeometry(cast.width, cast.height, canvasW, canvasH),
      DEFAULT_THEME,
    );
    const startSec = Math.max(0, (failing.startedAt - cast.startedAtMs) / 1000);
    const endSec = Math.max(startSec, (failing.endedAt - cast.startedAtMs) / 1000);
    for (let i = 0; i < COUNT; i++) {
      const t = startSec + ((endSec - startSec) * i) / Math.max(1, COUNT - 1);
      await player.advanceTo(t);
      renderer.compose(player.screen());
      shots.push(Buffer.from(renderer.readPixels()));
    }
    return shots;
  }

  const manifest = capture.frames[watched];
  if (manifest && manifest.frames.length > 0) {
    const renderer = new BrowserFrameRenderer({ width: canvasW, height: canvasH }, DEFAULT_THEME);
    const inScene = manifest.frames.filter(
      (f) => f.tSec * 1000 >= failing.startedAt && f.tSec * 1000 <= failing.endedAt,
    );
    const pool = inScene.length > 0 ? inScene : manifest.frames;
    for (let i = 0; i < Math.min(COUNT, pool.length); i++) {
      const idx = Math.round((i * (pool.length - 1)) / Math.max(1, Math.min(COUNT, pool.length) - 1));
      await renderer.compose(pool[idx]!.path);
      shots.push(Buffer.from(renderer.readPixels()));
    }
  }
  return shots;
}
