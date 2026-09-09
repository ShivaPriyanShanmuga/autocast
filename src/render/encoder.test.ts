import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrames, probeVideo } from './encoder.js';

const dir = mkdtempSync(join(tmpdir(), 'castscript-enc-'));
afterAll(() =>
  // Windows can hold a brief lock on a just-closed file; retry rather
  // than fail the suite on cleanup.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
);

const W = 160;
const H = 120;

async function* solid(count: number, value: number) {
  const frame = Buffer.alloc(W * H * 4, value);
  for (let i = 0; i < count; i++) yield frame;
}

describe('encodeFrames', () => {
  it('writes a playable mp4 with the exact frame count', async () => {
    const out = join(dir, 'a.mp4');
    const result = await encodeFrames(solid(30, 90), {
      width: W,
      height: H,
      fps: 30,
      outputPath: out,
    });
    expect(result.frames).toBe(30);
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(W);
    expect(probe.height).toBe(H);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(30);
  }, 60000);

  it('creates the output directory if it does not exist', async () => {
    const out = join(dir, 'nested', 'deep', 'b.mp4');
    await encodeFrames(solid(5, 10), { width: W, height: H, fps: 30, outputPath: out });
    expect(existsSync(out)).toBe(true);
  }, 60000);

  it('rejects when no frames are produced', async () => {
    async function* none(): AsyncGenerator<Buffer> {
      // yields nothing
    }
    await expect(
      encodeFrames(none(), { width: W, height: H, fps: 30, outputPath: join(dir, 'c.mp4') }),
    ).rejects.toThrow(/no frames/i);
  }, 60000);

  it('rejects a frame of the wrong size rather than producing a skewed video', async () => {
    async function* wrong() {
      yield Buffer.alloc(W * H * 4);
      yield Buffer.alloc(10);
    }
    await expect(
      encodeFrames(wrong(), { width: W, height: H, fps: 30, outputPath: join(dir, 'd.mp4') }),
    ).rejects.toThrow(/frame 1 is 10 bytes, expected \d+/i);
  }, 60000);
});

describe('audio muxing', () => {
  const frames = async function* (n: number): AsyncGenerator<Buffer> {
    for (let i = 0; i < n; i++) yield Buffer.alloc(64 * 48 * 4, i);
  };

  it('leaves the video mute when no audio is given', async () => {
    const out = join(dir, 'mute.mp4');
    await encodeFrames(frames(60), { width: 64, height: 48, fps: 30, outputPath: out });
    expect((await probeVideo(out)).audioCodec).toBeNull();
  }, 60_000);

  it('muxes a wav in as an aac track without changing the video length', async () => {
    const { FakeVoice } = await import('../voice/fake.js');
    const { buildTrack } = await import('../voice/timeline.js');
    const clip = await new FakeVoice().synthesize(
      { text: 'one two three four five', voice: 't', rate: 1 },
      join(dir, 'clip.wav'),
    );
    const track = join(dir, 'track.wav');
    await buildTrack([{ startSec: 0.2, ...clip }], 2, track);

    const mute = join(dir, 'a-mute.mp4');
    const withAudio = join(dir, 'a-sound.mp4');
    await encodeFrames(frames(60), { width: 64, height: 48, fps: 30, outputPath: mute });
    await encodeFrames(frames(60), {
      width: 64,
      height: 48,
      fps: 30,
      outputPath: withAudio,
      audioPath: track,
    });

    const probe = await probeVideo(withAudio);
    expect(probe.audioCodec).toBe('aac');
    // -shortest must not eat frames off the end.
    expect(probe.frames).toBe((await probeVideo(mute)).frames);
  }, 120_000);

  it('fails loudly when the audio file is missing', async () => {
    await expect(
      encodeFrames(frames(30), {
        width: 64,
        height: 48,
        fps: 30,
        outputPath: join(dir, 'no-audio.mp4'),
        audioPath: join(dir, 'does-not-exist.wav'),
      }),
    ).rejects.toThrow();
  }, 60_000);
});
