import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { writeContactSheet } from './contact-sheet.js';

const dir = mkdtempSync(join(tmpdir(), 'autodemo-sheet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const size = { width: 64, height: 36 };
const frame = (fill: number) => Buffer.alloc(size.width * size.height * 4, fill);

describe('writeContactSheet', () => {
  it('writes a png', async () => {
    const path = await writeContactSheet(join(dir, 'a.png'), [frame(10), frame(200)], size);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
    const img = await loadImage(path);
    expect(img.width).toBeGreaterThan(size.width);
  });

  it('tiles several frames into one image', async () => {
    const path = await writeContactSheet(
      join(dir, 'b.png'),
      [frame(10), frame(60), frame(120), frame(200)],
      size,
    );
    const img = await loadImage(path);
    expect(img.width * img.height).toBeGreaterThan(size.width * size.height);
  });

  it('caps the number of tiles so the sheet cannot grow without bound', async () => {
    const many = Array.from({ length: 30 }, (_, i) => frame(i * 8));
    const path = await writeContactSheet(join(dir, 'c.png'), many, size);
    const img = await loadImage(path);
    expect(img.width).toBeLessThanOrEqual(size.width * 3 + 40);
  });

  it('creates the directory if needed', async () => {
    const path = await writeContactSheet(join(dir, 'deep', 'd.png'), [frame(5)], size);
    expect(existsSync(path)).toBe(true);
  });

  it('handles an empty frame list without throwing', async () => {
    await expect(writeContactSheet(join(dir, 'e.png'), [], size)).resolves.toBeTruthy();
  });
});
