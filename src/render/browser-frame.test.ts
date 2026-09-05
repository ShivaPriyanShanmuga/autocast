import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { DEFAULT_THEME } from './theme.js';
import { BrowserFrameRenderer, composeBrowserWithCursor } from './browser-frame.js';
import type { CursorKeyframe } from './cursor.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-bf-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** Write a solid-colour JPEG to disk and return its path. */
function jpeg(name: string, colour: string, w = 320, h = 200): string {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  const path = join(dir, name);
  writeFileSync(path, canvas.toBuffer('image/jpeg'));
  return path;
}

const geometry = { width: 640, height: 360 };

describe('BrowserFrameRenderer', () => {
  it('returns an RGBA buffer of exactly width * height * 4', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const buf = await r.render(jpeg('a.jpg', '#ff0000'));
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
  });

  it('paints the source image', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const buf = await r.render(jpeg('red.jpg', '#ff0000'));
    // Centre pixel should be dominated by red.
    const mid = (geometry.height / 2) * geometry.width * 4 + (geometry.width / 2) * 4;
    expect(buf[mid]!).toBeGreaterThan(200);
    expect(buf[mid + 1]!).toBeLessThan(80);
  });

  it('renders a null source as the theme background rather than throwing', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const buf = await r.render(null);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
    expect(buf[0]).toBe(parseInt(DEFAULT_THEME.background.slice(1, 3), 16));
  });

  it('is deterministic for the same source', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const path = jpeg('same.jpg', '#00ff00');
    expect(Buffer.compare(await r.render(path), await r.render(path))).toBe(0);
  });

  it('distinguishes different sources', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const a = await r.render(jpeg('g.jpg', '#00ff00'));
    const b = await r.render(jpeg('b.jpg', '#0000ff'));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('decodes a repeated source only once', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const path = jpeg('cached.jpg', '#123456');
    await r.render(path);
    await r.render(path);
    await r.render(path);
    expect(r.decodeCount).toBe(1);
  });

  it('letterboxes a source with a different aspect ratio without distortion', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    // 320x200 is 1.6; the canvas is 640x360, i.e. 1.78. Fitting by height
    // leaves bars left and right, which must be background, not stretched.
    const buf = await r.render(jpeg('wide.jpg', '#ff00ff', 320, 200));
    expect(buf[0]).toBe(parseInt(DEFAULT_THEME.background.slice(1, 3), 16));
  });

  it('recovers from an unreadable file by painting the background', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const bad = join(dir, 'not-an-image.jpg');
    writeFileSync(bad, 'this is not a jpeg');
    const buf = await r.render(bad);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
  });

  it('lets overlays draw between compose and readPixels', async () => {
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const path = jpeg('overlay.jpg', '#00ff00');

    await r.compose(path);
    const plain = r.readPixels();

    await r.compose(path);
    r.context.fillStyle = '#ff0000';
    r.context.fillRect(0, 0, 40, 40);
    const drawn = r.readPixels();

    expect(Buffer.compare(plain, drawn)).not.toBe(0);
  });
});

describe('composeBrowserWithCursor', () => {
  const geometry = { width: 640, height: 360 };
  const pointers: CursorKeyframe[] = [
    { tSec: 0, at: { x: 100, y: 80 } },
    { tSec: 1, at: { x: 300, y: 200 }, click: true },
  ];

  it('draws the cursor onto the composed frame', async () => {
    const path = jpeg('cursor-base.jpg', '#ffffff');

    const bare = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const without = await bare.render(path);

    const withCursor = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(withCursor, path, pointers, 1.0);

    // This is the regression guard: phase 3a's composed path called
    // compose() directly and silently dropped the cursor.
    expect(Buffer.compare(without, withCursor.readPixels())).not.toBe(0);
  });

  it('draws nothing extra before the first keyframe', async () => {
    const path = jpeg('cursor-early.jpg', '#ffffff');

    const bare = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    const without = await bare.render(path);

    const early = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(early, path, pointers, -0.5);

    expect(Buffer.compare(without, early.readPixels())).toBe(0);
  });

  it('moves the cursor as time advances', async () => {
    const path = jpeg('cursor-move.jpg', '#ffffff');

    const a = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(a, path, pointers, 0.1);
    const early = a.readPixels();

    const b = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await composeBrowserWithCursor(b, path, pointers, 1.0);

    expect(Buffer.compare(early, b.readPixels())).not.toBe(0);
  });

  it('tolerates an empty pointer track', async () => {
    const path = jpeg('cursor-none.jpg', '#ffffff');
    const r = new BrowserFrameRenderer(geometry, DEFAULT_THEME);
    await expect(composeBrowserWithCursor(r, path, [], 1.0)).resolves.toBeUndefined();
    expect(r.readPixels().length).toBe(geometry.width * geometry.height * 4);
  });
});
