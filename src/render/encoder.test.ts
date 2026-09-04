import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrames, probeVideo } from './encoder.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-enc-'));
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
