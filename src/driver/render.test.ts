import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { probeVideo } from '../render/encoder.js';
import { createRequire } from 'node:module';
import { renderDemo, formatRenderReport, vttPathFor } from './render.js';
import { speechDurationSec } from '../render/speech.js';
import { rmsAt } from '../voice/rms.js';
import { SCENE_TAIL_SEC } from '../render/composition.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-render-'));
afterAll(() =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
);

function load(path: string) {
  const { script, diagnostics } = checkSchema(parseSource(readFileSync(path, 'utf8')));
  if (!script) throw new Error(`fixture invalid: ${JSON.stringify(diagnostics)}`);
  return script;
}


/**
 * Mean luminance of the top and bottom bands of a video's middle frame.
 *
 * Captions are checked as numbers, never by looking: section 3 forbids
 * frames from reaching agent context, and "is the caption there" is a
 * question a band average answers exactly.
 */
async function bandLuma(videoPath: string): Promise<{ top: number; bottom: number }> {
  const { spawn } = await import('node:child_process');
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const png = join(dir, `${Math.random().toString(36).slice(2)}.png`);

  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      'ffmpeg',
      ['-y', '-v', 'error', '-ss', '1.5', '-i', videoPath, '-frames:v', '1', png],
      { stdio: 'ignore', windowsHide: true },
    );
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });

  const img = await loadImage(readFileSync(png));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const mean = (y0: number, y1: number): number => {
    const d = ctx.getImageData(0, y0, img.width, y1 - y0).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    }
    return sum / (d.length / 4);
  };

  return {
    top: mean(0, Math.round(img.height * 0.4)),
    bottom: mean(Math.round(img.height * 0.78), img.height),
  };
}

/** Pull a video's audio out as mono 16-bit wav so it can be measured. */
async function extractAudio(videoPath: string, wavPath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', videoPath, '-vn', '-acodec', 'pcm_s16le',
       '-ar', '24000', '-ac', '1', wavPath],
      { stdio: 'ignore', windowsHide: true },
    );
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
}

describe('renderDemo', () => {
  it('produces a playable mp4 of the terminal fixture', async () => {
    const out = join(dir, 'demo.mp4');
    const report = await renderDemo(load('fixtures/terminal/demo.yaml'), { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(report.frames).toBeGreaterThan(30);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
  }, 180000);

  it('reports failure when an assertion fails', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const out = join(dir, 'failed.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok).toBe(false);
    expect(report.scenes[0]!.assertions[0]!.ok).toBe(false);
  }, 180000);
});

describe('formatRenderReport', () => {
  it('renders a readable summary naming each scene', () => {
    const text = formatRenderReport({
      ok: false,
      outputPath: 'docs/demo.mp4',
      frames: 120,
      durationSec: 4,
      scenes: [
        { id: 'greet', ok: true, assertions: [{ name: 'stdout_contains', ok: true }] },
        {
          id: 'build',
          ok: false,
          assertions: [{ name: 'stdout_matches', ok: false, detail: 'no match' }],
        },
      ],
    });
    expect(text).toContain('greet');
    expect(text).toContain('build');
    expect(text).toContain('no match');
    expect(text).toContain('FAILED');
  });
});

describe('renderDemo with a browser session', () => {
  const PORT = 34601;
  let server: import('node:child_process').ChildProcess;

  beforeAll(async () => {
    const { spawn } = await import('node:child_process');
    server = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      server.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('listening on')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }, 30000);

  afterAll(() => server.kill());

  it('produces a playable mp4 of the web fixture', async () => {
    const script = load('fixtures/browser/demo.yaml');
    script.scenes[0]!.steps![0] = { goto: `http://127.0.0.1:${PORT}/` };

    const out = join(dir, 'browser.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(report.frames).toBeGreaterThan(30);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
  }, 240000);

});


/**
 * The flagship starts a server on a fixed port from inside the demo, so
 * two tests rendering it concurrently collide on that port. Vitest runs
 * files in parallel, so every flagship render needs its own port.
 */
function loadFlagshipOnPort(port: number) {
  const { writeFileSync, readFileSync: read } = require('node:fs') as typeof import('node:fs');
  const yaml = read('fixtures/flagship/demo.yaml', 'utf8').replace(/34700/g, String(port));
  const path = join(dir, `flagship-${port}.yaml`);
  writeFileSync(path, yaml);
  return load(path);
}

describe('renderDemo with mixed sessions', () => {
  it('renders the flagship as one continuous mp4 and holds the step-less scene', async () => {
    const script = loadFlagshipOnPort(34710);
    const out = join(dir, 'flagship.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(report.scenes.map((s) => s.id)).toEqual(script.scenes.map((s) => s.id));
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
    expect(report.frames).toBeGreaterThan(90);

    // The `logs` scene has no steps; without a minimum hold the video
    // would be barely longer than the two acting scenes.
    expect(report.durationSec).toBeGreaterThan(4);
  }, 300000);
});

describe('pacing', () => {
  it('still renders a correct flagship once idle compression and fades apply', async () => {
    const script = loadFlagshipOnPort(34711);
    const out = join(dir, 'paced.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(report.scenes.map((s) => s.id)).toEqual(script.scenes.map((s) => s.id));
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.frames).toBe(report.frames);

    // Three scenes each keep an uncompressed tail, so however aggressively
    // idle is compressed the video cannot collapse below their sum.
    expect(report.durationSec).toBeGreaterThan(3 * SCENE_TAIL_SEC);
  }, 300000);
});

describe('failing runs produce no video', () => {
  it('does not encode when an assertion fails', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const out = join(dir, 'should-not-exist.mp4');

    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok).toBe(false);
    expect(report.frames).toBe(0);
    // The whole point: no plausible-looking artifact for a broken demo.
    expect(existsSync(out)).toBe(false);
  }, 120000);

  it('removes a stale video left by an earlier successful run', async () => {
    const { writeFileSync } = await import('node:fs');
    const out = join(dir, 'stale.mp4');
    writeFileSync(out, 'pretend this is last weeks good render');

    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    await renderDemo(script, { outputPath: out });

    expect(existsSync(out)).toBe(false);
  }, 120000);

  it('is fast, because it never reaches the encoder', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const t0 = Date.now();
    await renderDemo(script, { outputPath: join(dir, 'fast.mp4') });
    // Capture of one short scene, then stop. The baseline took 63s.
    expect(Date.now() - t0).toBeLessThan(30000);
  }, 120000);
});

describe('captions', () => {
  it('writes a vtt sidecar whose cues match the narrated scenes', async () => {
    const script = loadFlagshipOnPort(34713);
    const report = await renderDemo(script, { outputPath: join(dir, 'captioned.mp4') });
    expect(report.ok).toBe(true);

    const vtt = await readFile(vttPathFor(join(dir, 'captioned.mp4')), 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);

    // One cue per narrated scene, in order, and every cue inside the video.
    const stamps = [...vtt.matchAll(/^(\d\d:\d\d:\d\d\.\d\d\d) --> (\d\d:\d\d:\d\d\.\d\d\d)$/gm)];
    const narrated = script.scenes.filter((s) => s.narrate?.trim()).length;
    expect(stamps.length).toBe(narrated);

    const toSec = (t: string): number => {
      const [h, m, rest] = t.split(':');
      return Number(h) * 3600 + Number(m) * 60 + Number(rest);
    };
    let previousEnd = 0;
    for (const [, start, end] of stamps) {
      expect(toSec(start!)).toBeGreaterThanOrEqual(previousEnd - 1e-6);
      expect(toSec(end!)).toBeGreaterThan(toSec(start!));
      previousEnd = toSec(end!);
    }
    // The last cue ends when the video does.
    expect(previousEnd).toBeCloseTo(report.durationSec, 0);
  }, 180_000);

  it('draws in the caption band and nowhere near the top of the frame', async () => {
    // Verified by pixel band rather than by looking: section 3 forbids
    // frames reaching agent context, so the check is a number.
    const on = loadFlagshipOnPort(34714);
    const off = { ...on, style: { ...on.style, captions: false } } as typeof on;

    const onPath = join(dir, 'cap-on.mp4');
    const offPath = join(dir, 'cap-off.mp4');
    await renderDemo(on, { outputPath: onPath });
    await renderDemo(off, { outputPath: offPath });

    const a = await bandLuma(onPath);
    const b = await bandLuma(offPath);
    // Magnitude, not direction: over the dark terminal the white text
    // outweighs the scrim and the band gets BRIGHTER, over a white page
    // the scrim wins and it gets darker. Either way it changes, and the
    // top of the frame does not.
    expect(Math.abs(a.bottom - b.bottom)).toBeGreaterThan(1);
    expect(Math.abs(a.top - b.top)).toBeLessThan(1);
  }, 300_000);

  it('does not write a sidecar when captions are off', async () => {
    const base = loadFlagshipOnPort(34715);
    const script = { ...base, style: { ...base.style, captions: false } } as typeof base;
    const path = join(dir, 'nocap.mp4');
    await rm(vttPathFor(path), { force: true });
    await renderDemo(script, { outputPath: path });
    await expect(readFile(vttPathFor(path), 'utf8')).rejects.toThrow();
  }, 180_000);
});

describe('voice', () => {
  // The terminal fixture, not the flagship: these test AUDIO, and a
  // browser plus a web server per case made the suite slow enough to
  // start flaking other tests on timing.
  const voiced = (over: Record<string, unknown>) =>
    ({ ...load('fixtures/terminal/demo.yaml'), voice: { enabled: true, backend: 'fake', ...over } }) as ReturnType<typeof load>;

  it('muxes narration on and keeps the durations agreeing', async () => {
    const out = join(dir, 'voiced.mp4');
    const report = await renderDemo(voiced({}), { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    const probe = await probeVideo(out);
    expect(probe.audioCodec).toBe('aac');
    // -shortest must not trim a frame off the picture.
    expect(probe.frames).toBe(report.frames);
  }, 180_000);

  it('has sound at EVERY cue, not just the first two', async () => {
    // The bug this exists for: a shipped voiceover fell silent after the
    // second scene. Everything upstream looked right — four clips, four
    // cues, an aac stream of the right length — because nothing measured
    // whether sound was actually THERE. Checked as numbers, never by
    // listening (spec section 3).
    const out = join(dir, 'cues.mp4');
    const report = await renderDemo(voiced({}), { outputPath: out });
    expect(report.ok).toBe(true);

    const wav = join(dir, 'cues.wav');
    await extractAudio(out, wav);

    const vtt = readFileSync(vttPathFor(out), 'utf8');
    const starts = [...vtt.matchAll(/^(\d\d):(\d\d):(\d\d\.\d\d\d) -->/gm)].map(
      (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
    );
    expect(starts.length).toBeGreaterThan(1);

    for (const [i, startSec] of starts.entries()) {
      const level = await rmsAt(wav, startSec + 0.05, startSec + 0.5);
      expect(level, `cue ${i} at ${startSec}s is silent`).toBeGreaterThan(0.001);
    }
  }, 180_000);

  it('leaves the video mute when voice is not asked for', async () => {
    const out = join(dir, 'unvoiced.mp4');
    await renderDemo(load('fixtures/terminal/demo.yaml'), { outputPath: out });
    expect((await probeVideo(out)).audioCodec).toBeNull();
  }, 180_000);

  it('paces scenes on the MEASURED duration, not the estimate', async () => {
    // The point of phase 6a taking a duration rather than a text: with
    // voice on, the number in the report comes from the audio file.
    const out = join(dir, 'fast.mp4');
    await renderDemo(voiced({ rate: 2 }), { outputPath: out });

    const report = JSON.parse(readFileSync(join(dir, 'fast.report.json'), 'utf8')) as {
      measured: { narrationSec: Record<string, number> };
    };
    const greet = report.measured.narrationSec.greet!;
    expect(greet).toBeGreaterThan(0);
    // Speaking twice as fast halves it, so the estimate cannot be what
    // was recorded.
    expect(greet).toBeLessThan(speechDurationSec('First, a greeting.') * 0.75);
  }, 180_000);

  it('fails with a named error when the engine is not installed', async () => {
    const { KokoroVoice } = await import('../voice/kokoro.js');
    const { VoiceUnavailableError } = await import('../voice/backend.js');
    let installed = true;
    try {
      createRequire(import.meta.url).resolve('kokoro-js');
    } catch {
      installed = false;
    }
    if (installed) return; // the engine's own test covers the other side

    await expect(
      new KokoroVoice().synthesize({ text: 'hi', voice: 'af_heart', rate: 1 }, join(dir, 'x.wav')),
    ).rejects.toThrow(VoiceUnavailableError);
  }, 60_000);
});

describe('sync: strict', () => {
  const wordy = Array.from({ length: 90 }, () => 'extremely').join(' ');
  const overrun = (sync: 'hold' | 'strict') => {
    const base = load('fixtures/terminal/demo.yaml');
    return {
      ...base,
      voice: { enabled: true, backend: 'fake', sync },
      scenes: base.scenes.map((s) => (s.id === 'greet' ? { ...s, narrate: wordy } : s)),
    } as typeof base;
  };

  it('refuses to encode when narration is driving the pacing', async () => {
    // Spec 7.1 lever 4: fail loudly, not a silently ugly video. Since
    // 7.1.1's floor makes narration always FIT, the failure worth having
    // is that the picture is being held open to finish a sentence.
    const out = join(dir, 'strict.mp4');
    await rm(out, { force: true });
    const report = await renderDemo(overrun('strict'), { outputPath: out });

    expect(report.ok).toBe(false);
    expect(report.frames).toBe(0);
    expect(existsSync(out)).toBe(false);
    const finding = report.findings.find((f) => f.code === 'H005');
    expect(finding?.scene).toBe('greet');
    expect(finding?.detail).toMatch(/held open/);
  }, 180_000);

  it('renders the same demo anyway in hold mode', async () => {
    const report = await renderDemo(overrun('hold'), { outputPath: join(dir, 'hold.mp4') });
    expect(report.ok).toBe(true);
    expect(report.frames).toBeGreaterThan(0);
  }, 180_000);
});
