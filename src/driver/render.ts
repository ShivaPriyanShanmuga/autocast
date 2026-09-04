import type { DemoScript } from '../schema/demo.js';
import type { CastLog } from '../backends/terminal/cast.js';
import { BrowserFrameRenderer } from '../render/browser-frame.js';
import { cursorAt, drawCursor } from '../render/cursor.js';
import { encodeFrames } from '../render/encoder.js';
import { browserFrameCount, resampleManifest } from '../render/resample.js';
import { fitGeometry, FrameRenderer } from '../render/frame.js';
import { frameCount, replayCast } from '../render/replay.js';
import { DEFAULT_THEME } from '../render/theme.js';
import { captureDemo } from './capture.js';

export interface RenderReport {
  ok: boolean;
  outputPath: string;
  scenes: Array<{
    id: string;
    ok: boolean;
    assertions: Array<{ name: string; ok: boolean; detail?: string }>;
  }>;
  frames: number;
  durationSec: number;
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

  // Guard BEFORE capturing: running a capture only to discard it would
  // waste a browser launch and a terminal session.
  const kinds = new Set(Object.values(script.sessions).map((s) => s.backend));
  if (kinds.size > 1) {
    throw new Error(
      'this demo mixes terminal and browser sessions, which composes in Phase 3. ' +
        'Phase 2 renders a demo whose sessions are all one kind.',
    );
  }
  if (Object.keys(script.sessions).length > 1) {
    throw new Error('this demo declares more than one session, which composes in Phase 3.');
  }

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

    const ticks = resampleManifest(manifest, { fps });
    const browserRenderer = new BrowserFrameRenderer(
      { width: canvasW, height: canvasH },
      DEFAULT_THEME,
    );

    async function* browserFrames(): AsyncGenerator<Buffer> {
      for (const tick of ticks) {
        await browserRenderer.compose(tick.source?.path ?? null);
        const cursor = cursorAt(pointers, tick.tSec);
        if (cursor) {
          drawCursor(browserRenderer.context, cursor.at, { clickAge: cursor.clickAge });
        }
        yield browserRenderer.readPixels();
      }
    }

    const encoded = await encodeFrames(browserFrames(), {
      width: canvasW,
      height: canvasH,
      fps,
      outputPath,
    });

    return {
      ok: scenes.every((s) => s.ok),
      outputPath,
      scenes,
      frames: encoded.frames,
      durationSec: Number((browserFrameCount(manifest, fps) / fps).toFixed(2)),
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
      yield renderer.render(screen);
    }
  }

  const { frames: written } = await encodeFrames(frames(), {
    width: geometry.width,
    height: geometry.height,
    fps,
    outputPath,
  });

  return {
    ok: scenes.every((s) => s.ok),
    outputPath,
    scenes,
    frames: written,
    durationSec: Number((total / fps).toFixed(2)),
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

  lines.push('');
  lines.push(`  ${report.frames} frames, ${report.durationSec}s`);
  lines.push('');
  lines.push(
    report.ok
      ? `OK — ${report.scenes.length} of ${report.scenes.length} scenes`
      : `FAILED — ${report.scenes.filter((s) => !s.ok).length} of ${report.scenes.length} scenes`,
  );

  return lines.join('\n');
}
