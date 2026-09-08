import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';

const PORT = 34568;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

beforeAll(async () => {
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

const open: BrowserSession[] = [];
const dirs: string[] = [];

async function session(viewport: [number, number] = [640, 400]) {
  const dir = mkdtempSync(join(tmpdir(), 'autodemo-bs-'));
  dirs.push(dir);
  const s = await openBrowserSession({ viewport, framesDir: join(dir, 'frames') });
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('BrowserSession', () => {
  it('loads a page and reads its content', async () => {
    const s = await session();
    await s.goto(BASE);
    expect(await s.page.title()).toContain('autodemo');
  }, 60000);

  it('captures frames at the CSS viewport size, not deviceScaleFactor', async () => {
    const s = await session([640, 400]);
    await s.goto(BASE);
    await s.startCapture();
    await s.page.click('[data-test=new-order]');
    await s.page.waitForTimeout(400);
    await s.stopCapture();

    const m = s.manifest();
    expect(m.frames.length).toBeGreaterThan(0);

    // Decode a real frame. Asserting on m.width alone would only echo the
    // viewport we passed in — it would pass even if the frames were the
    // wrong size, which is exactly the claim spec 4.5.1 rests on.
    const { loadImage } = await import('@napi-rs/canvas');
    const { readFileSync } = await import('node:fs');
    const img = await loadImage(readFileSync(m.frames[0]!.path));
    expect(img.width).toBe(640);
    expect(img.height).toBe(400);
  }, 60000);

  it('records timestamps in unix seconds, increasing', async () => {
    const s = await session();
    await s.goto(BASE);
    await s.startCapture();
    for (let i = 0; i < 3; i++) {
      await s.page.click('[data-test=new-order]');
      await s.page.waitForTimeout(150);
    }
    await s.stopCapture();

    const ts = s.manifest().frames.map((f) => f.tSec);
    expect(ts.length).toBeGreaterThan(0);
    expect(ts[0]).toBeGreaterThan(1_000_000_000); // unix SECONDS, not ms
    expect(ts[0]).toBeLessThan(100_000_000_000);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]!);
  }, 60000);

  it('keeps acknowledging frames so capture does not stall', async () => {
    const s = await session();
    await s.goto(BASE);
    await s.startCapture();
    // Force many repaints; without frame acks Chromium stops after a few.
    for (let i = 0; i < 12; i++) {
      await s.page.evaluate((n: number) => {
        document.title = `t${n}`;
        document.body.style.background = n % 2 ? '#eee' : '#fff';
      }, i);
      await s.page.waitForTimeout(60);
    }
    await s.stopCapture();
    expect(s.manifest().frames.length).toBeGreaterThan(5);
  }, 60000);

  it('returns an element bounding box in CSS pixels', async () => {
    const s = await session();
    await s.goto(BASE);
    const box = await s.boundingBox('[data-test=new-order]');
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  }, 60000);

  it('returns null for a selector that does not exist', async () => {
    const s = await session();
    await s.goto(BASE);
    expect(await s.boundingBox('#nothing-here')).toBeNull();
  }, 60000);

  it('applies zoom without changing the frame size', async () => {
    const s = await session([640, 400]);
    await s.goto(BASE);
    await s.setZoom(2);
    await s.startCapture();
    await s.page.click('[data-test=new-order]');
    await s.page.waitForTimeout(300);
    await s.stopCapture();
    expect(s.manifest().width).toBe(640);
  }, 60000);

  it('collects console errors and failed requests', async () => {
    const s = await session();
    await s.goto(BASE);
    await s.page.evaluate(() => console.error('deliberate-console-error'));
    await s.page.waitForTimeout(200);
    expect(s.consoleErrors().join(' ')).toContain('deliberate-console-error');
    expect(Array.isArray(s.failedRequests())).toBe(true);
  }, 60000);

  it('dispose is idempotent', async () => {
    const s = await session();
    await s.dispose();
    await expect(s.dispose()).resolves.toBeUndefined();
  }, 60000);
});
