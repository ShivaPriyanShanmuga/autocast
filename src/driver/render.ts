import type { DemoScript } from '../schema/demo.js';
import type { CastLog } from '../backends/terminal/cast.js';
import { BrowserFrameRenderer, composeBrowserWithCursor } from '../render/browser-frame.js';
import type { CursorKeyframe, ZoomKeyframe } from '../render/cursor.js';
import { Presenter } from '../render/present.js';
import { resolveStyle } from '../render/style.js';
import type { Canvas } from '@napi-rs/canvas';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectDurationAnomaly,
  detectSilentNarration,
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
import { planComposition, type SceneFocus } from '../render/composition.js';
import { captionLineChars, drawCaption, wrapCaption } from '../render/caption.js';
import { speechDurationSec } from '../render/speech.js';
import { buildVtt, cuesFromPlan } from '../render/vtt.js';
import { resolveVoice, voiceBackendFor } from '../voice/index.js';
import { synthesizeCached } from '../voice/cache.js';
import { buildTrack, planClips } from '../voice/timeline.js';
import { checkSync, stretchFor } from '../verify/sync.js';
import type { SynthesisResult } from '../voice/backend.js';
import { planFrame } from '../render/frame-plan.js';
import { findInScreen } from '../render/find-in-screen.js';
import {
  browserRectToPixels,
  cellRectToPixels,
  zoomedCamera,
  type Rect,
} from '../render/camera.js';
import { LayoutCompositor } from '../render/layout.js';
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
import { checkOutputPath } from './output-path.js';
import { nextStepFor } from '../cli/playbook.js';

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

/** Slack on the audio bed so `-shortest` can never trim the picture. */
const AUDIO_TAIL_PAD_SEC = 0.25;

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

  // narrate: is presented by default; style.captions turns it off
  // (spec section 7.1.2). Time is reserved only for narration a viewer
  // can actually perceive, so the floor and the caption switch together.
  const captionsOn = script.style?.captions ?? true;
  const speechRate = script.defaults?.speech_rate;
  const narrationTextByScene: Record<string, string> = {};
  const narrationByScene: Record<string, number> = {};
  const spokenTextByScene: Record<string, string> = {};
  if (captionsOn) {
    for (const scene of script.scenes) {
      const text = scene.narrate?.trim();
      if (!text) continue;
      narrationTextByScene[scene.id] = text;
      // What the VOICE says may differ from what the caption shows: a
      // speech engine cannot tell "live" the adjective from "live" the
      // verb, but the author can (spec 7.1.4).
      spokenTextByScene[scene.id] = scene.speak?.trim() || text;
      narrationByScene[scene.id] = speechDurationSec(text, speechRate);
    }
  }
  const narrates = Object.keys(narrationByScene).length > 0;
  const voice = resolveVoice(script);

  // More than one session, or any explicit layout, needs the composed
  // path; a single session keeps the simpler phase 1/2 fast paths.
  //
  // So does any zoom. Zoom is now a camera driven by the scene's tail,
  // and the composition plan is the only thing that knows when a scene's
  // tail is — the flat paths have no scene timeline at all.
  const needsComposition =
    Object.keys(script.sessions).length > 1 ||
    script.scenes.some((s) => s.layout !== undefined || s.focus !== undefined) ||
    (script.style?.zoom?.auto ?? false) ||
    // Captions need a scene timeline to hang a cue on, which the flat
    // single-session paths do not have.
    narrates;

  const resolvedStyle = resolveStyle(script.style);
  const presenter = new Presenter(canvasW, canvasH, resolvedStyle);

  // Before capture, not after. Capture is the expensive half, and until
  // this ran first a demo could spend a minute recording and then die
  // because its destination was a directory.
  await checkOutputPath(outputPath);

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
  // Say it before anything else: a silent video the author expected to
  // speak is the single most repeated surprise this tool produced.
  findings.push(
    ...detectSilentNarration({
      hasNarration: script.scenes.some((s2) => (s2.narrate ?? '').trim() !== ''),
      captionsOn,
      voiceEnabled: voice.enabled,
    }),
  );
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

  const finish = async (
    frames: number,
    durationSec: number,
    ok = capture.ok,
  ): Promise<string> =>
    writeReport(
      outputPath,
      buildReport({
        ok,
        scenes: sceneSecs,
        findings,
        abortedAt: capture.abortedAt,
        frames,
        durationSec,
        narrationSec: Object.fromEntries(
          Object.entries(narrationByScene).map(([id, sec]) => [id, Number(sec.toFixed(3))]),
        ),
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
            join('.castscript', 'failed', `${failing.id}-contact.png`),
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

  // Synthesize AFTER capture, never alongside it: inference pegs the CPU
  // and capture timings are what drive the pacing (spec 7.1.3).
  const synthesized: Record<string, SynthesisResult> = {};
  if (voice.enabled && narrates) {
    const backend = voiceBackendFor(voice);
    const cacheDir = join('.castscript', 'voice');
    const sceneSecById = new Map(sceneSecs.map((s2) => [s2.id, s2.sec]));

    for (const [id, captionText] of Object.entries(narrationTextByScene)) {
      const text = spokenTextByScene[id] ?? captionText;
      // Lever 3 before the floor: absorb a small overrun by speaking a
      // little faster rather than by holding the picture (spec 7.1.3).
      //
      // This costs a second synthesis for any scene that needs a stretch,
      // because how long a voice takes is not knowable without asking it
      // — the word-count estimate is only good to about 11%, which is the
      // size of the whole adjustment. Both passes are cached, so the cost
      // is paid once ever, not once per render.
      const dry = await synthesizeCached(
        backend,
        { text, voice: voice.voice, rate: voice.rate },
        cacheDir,
      );
      const stretch = stretchFor(dry.durationSec, sceneSecById.get(id) ?? 0);
      const result =
        stretch === 1
          ? dry
          : await synthesizeCached(
              backend,
              { text, voice: voice.voice, rate: voice.rate * stretch },
              cacheDir,
            );
      synthesized[id] = result;
      // The MEASURED duration replaces the estimate. This is the whole
      // point of 6a taking a duration rather than a text.
      narrationByScene[id] = result.durationSec;
    }

    const syncFindings = checkSync(
      Object.keys(narrationTextByScene).map((id) => ({
        id,
        narrationSec: synthesized[id]?.durationSec ?? 0,
        actionSec: sceneSecById.get(id) ?? 0,
      })),
      voice.sync,
    );
    findings.push(...syncFindings);

    // Lever 4 (spec 7.1): fail loudly rather than hand back a silently
    // ugly video. Checked BEFORE rendering, because the durations are
    // already known and encoding a video we intend to reject would cost
    // minutes to produce nothing.
    if (syncFindings.length > 0) {
      await rm(outputPath, { force: true });
      // The report on disk must agree with what we return; capture
      // succeeded, but the render did not.
      const reportPath = await finish(0, 0, false);
      return {
        ok: false,
        outputPath,
        scenes,
        findings,
        reportPath,
        contactSheetPath: null,
        frames: 0,
        durationSec: 0,
      };
    }
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
    const plan = planComposition(script, capture.scenes, {
      idleByScene,
      terminalSessions,
      browserFocusByScene: capture.zoomBoxes,
      narrationByScene,
      narrationTextByScene,
    });

    const captionChars = captionLineChars(canvasW);
    const captionLines = new Map<string, string[]>();
    for (const w of plan.windows) {
      const text = w.narration?.text.trim();
      if (text) captionLines.set(w.id, wrapCaption(text, captionChars));
    }

    // Which sessions are ever on screen while a camera is zoomed. Those
    // get rendered larger than the canvas so the camera has real pixels
    // to move over; a demo that never zooms pays none of this.
    const zoomedSessions = new Set<string>();
    for (const w of plan.windows) {
      if (!w.focus) continue;
      zoomedSessions.add(w.primary);
      if (w.inset) zoomedSessions.add(w.inset.session);
    }
    const zoomTarget = script.style?.zoom?.scale ?? 1.8;
    const ss = zoomedSessions.size > 0 ? zoomTarget : 1;
    const bigW = Math.round(canvasW * ss);
    const bigH = Math.round(canvasH * ss);

    // Two chains, differing only in size. The camera is applied to the
    // FINISHED frame of either — background, padding and rounded window
    // included — so zooming reads as moving into the screen rather than
    // scaling the contents of a window that stays pinned where it was.
    const compositor = new LayoutCompositor(canvasW, canvasH, DEFAULT_THEME);
    const zoomCompositor = new LayoutCompositor(bigW, bigH, DEFAULT_THEME);
    const zoomPresenter = new Presenter(bigW, bigH, {
      ...resolvedStyle,
      // Scale the frame with the canvas, or the padding and corners
      // shrink relative to the content.
      padding: Math.round(resolvedStyle.padding * ss),
      radius: Math.round(resolvedStyle.radius * ss),
    });

    // The output frame. Crossfades live here, after the camera, so a
    // zooming scene blends exactly like any other.
    const outCompositor = new LayoutCompositor(canvasW, canvasH, DEFAULT_THEME);

    const players = new Map<string, CastPlayer>();
    const terminalRenderers = new Map<string, FrameRenderer>();
    for (const [id, cast] of Object.entries(capture.casts)) {
      players.set(id, new CastPlayer(cast, DEFAULT_THEME));
      const sessionSs = zoomedSessions.has(id) ? ss : 1;
      terminalRenderers.set(
        id,
        new FrameRenderer(
          fitGeometry(
            cast.width,
            cast.height,
            Math.round(canvasW * sessionSs),
            Math.round(canvasH * sessionSs),
          ),
          DEFAULT_THEME,
        ),
      );
    }

    const browsers = new Map<string, BrowserFrameRenderer>();
    const browserTicks = new Map<string, ReturnType<typeof resampleManifest>>();
    const browserPointers = new Map<string, CursorKeyframe[]>();
    const browserZooms = new Map<string, ZoomKeyframe[]>();
    for (const [id, manifest] of Object.entries(capture.frames)) {
      const sessionSs = zoomedSessions.has(id) ? ss : 1;
      browsers.set(
        id,
        new BrowserFrameRenderer(
          {
            width: Math.round(canvasW * sessionSs),
            height: Math.round(canvasH * sessionSs),
          },
          DEFAULT_THEME,
        ),
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

    /**
     * Draw one session's state at a wall-clock instant onto its canvas,
     * and say where on that canvas the camera should look.
     *
     * Both backends answer the same question. A terminal resolves its
     * pattern against the character grid it just rendered; a browser
     * already has a box the DOM measured at capture time. Neither reads
     * a pixel to decide (spec section 3, constraint 2).
     */
    const surfaceFor = async (
      sessionId: string,
      wallMs: number,
      focus?: SceneFocus,
    ): Promise<{ surface: Canvas; focus: Rect | null }> => {
      const player = players.get(sessionId);
      if (player) {
        const cast = capture.casts[sessionId]!;
        const tSec = Math.max(0, (wallMs - cast.startedAtMs) / 1000);
        // Forward-only; a hold can ask for the same instant repeatedly.
        if (tSec >= player.position) await player.advanceTo(tSec);
        const renderer = terminalRenderers.get(sessionId)!;
        const screen = player.screen();
        renderer.compose(screen);

        if (focus?.kind !== 'terminal') return { surface: renderer.surface, focus: null };

        const cell = findInScreen(screen, focus.pattern);
        return {
          surface: renderer.surface,
          focus: cell ? cellRectToPixels(renderer.geometry, screen, cell) : null,
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

      if (focus?.kind !== 'browser') return { surface: browser.surface, focus: null };
      return {
        surface: browser.surface,
        focus: browserRectToPixels(
          { width: browser.surface.width, height: browser.surface.height },
          { width: manifest.width, height: manifest.height },
          focus.box,
        ),
      };
    };

    const totalFrames = Math.max(1, Math.ceil(plan.totalSec * fps));

    let previousWindowId: string | null = null;

    async function* composedFrames(): AsyncGenerator<Buffer> {
      for (let i = 0; i < totalFrames; i++) {
        const outSec = (i + 0.5) / fps;
        const frame = planFrame(plan, outSec, previousWindowId, zoomTarget);
        if (!frame) continue;
        const { window } = frame;

        // Snapshot BEFORE clearing: the output canvas still holds the
        // outgoing scene's last finished frame.
        if (frame.cut) outCompositor.snapshot();
        outCompositor.clear();

        // A zooming window composes at the supersampled size; every
        // window then goes through the same camera and the same fade.
        const zooming = window.focus !== null;
        const comp = zooming ? zoomCompositor : compositor;
        const pres = zooming ? zoomPresenter : presenter;
        const size = zooming
          ? { width: bigW, height: bigH }
          : { width: canvasW, height: canvasH };
        const radius = zooming ? Math.round(resolvedStyle.radius * ss) : resolvedStyle.radius;

        comp.clear();
        const primary = await surfaceFor(
          window.primary,
          frame.wallMs,
          window.focus ?? undefined,
        );
        comp.drawFullscreen(primary.surface);
        if (window.inset) {
          const inset = await surfaceFor(window.inset.session, frame.wallMs);
          comp.drawInset(inset.surface, window.inset, radius);
        }
        pres.presentToSurface(comp.surface);

        // The focus was measured on the source surface; the presenter
        // insets that surface by the padding, so carry it across.
        const content = pres.contentRect();
        const mapped = primary.focus
          ? {
              x: content.x + (primary.focus.x / size.width) * content.width,
              y: content.y + (primary.focus.y / size.height) * content.height,
              width: (primary.focus.width / size.width) * content.width,
              height: (primary.focus.height / size.height) * content.height,
            }
          : null;

        outCompositor.drawFullscreen(
          pres.surface,
          zoomedCamera(size, mapped, frame.zoom, zoomTarget),
        );

        // After the camera, so the caption does not scale and crop with a
        // zoom. Before the blend, so it belongs to the snapshot and
        // dissolves with its own scene instead of popping at the cut.
        const lines = captionLines.get(window.id);
        if (lines) {
          drawCaption(outCompositor.context, lines, { width: canvasW, height: canvasH });
        }

        outCompositor.fadeInPrevious(frame.fadeAlpha);

        previousWindowId = window.id;
        yield outCompositor.readPixels();
      }
    }

    // One track, anchored on the same windows the captions came from, so
    // voice and captions cannot drift apart.
    let audioPath: string | undefined;
    const clips = planClips(plan, synthesized);
    if (clips.length > 0) {
      audioPath = join('.castscript', 'voice', 'track.wav');
      // The bed is deliberately LONGER than the picture.
      //
      // `-shortest` cuts every stream to the shortest one, so the audio
      // must never be the shorter. Sizing it to the exact frame count is
      // not enough: AAC quantises to 1024-sample frames (~43ms at 24kHz),
      // so the encoded track can land just under the video and take a
      // real frame of picture with it. The surplus is silence, and
      // `-shortest` trims it back to the video's length.
      const videoSec = Math.ceil(plan.totalSec * fps) / fps;
      await buildTrack(clips, videoSec + AUDIO_TAIL_PAD_SEC, audioPath);
    }

    const encoded = await encodeFrames(composedFrames(), {
      width: canvasW,
      height: canvasH,
      fps,
      outputPath,
      ...(audioPath === undefined ? {} : { audioPath }),
    });

    // Same cues the burned-in captions came from, so the sidecar is a
    // faithful record rather than a parallel implementation.
    const cues = cuesFromPlan(plan);
    if (cues.length > 0) {
      await writeFile(vttPathFor(outputPath), buildVtt(cues), 'utf8');
    }

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

/** Where the caption sidecar goes: next to the video, same basename. */
export function vttPathFor(outputPath: string): string {
  return outputPath.replace(/\.[^./\\]+$/, '') + '.vtt';
}

export function formatRenderReport(report: RenderReport): string {
  const lines = [`castscript render — ${report.outputPath}`, ''];

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
