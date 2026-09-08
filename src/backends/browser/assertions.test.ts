import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';
import { evaluateBrowserAssertion } from './assertions.js';

const PORT = 34570;
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

async function session() {
  const dir = mkdtempSync(join(tmpdir(), 'autodemo-ba-'));
  dirs.push(dir);
  const s = await openBrowserSession({ viewport: [640, 400], framesDir: join(dir, 'frames') });
  open.push(s);
  await s.goto(BASE);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('evaluateBrowserAssertion', () => {
  it('visible passes for a shown element', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ visible: '[data-test=new-order]' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('visible fails for a hidden element and says so', async () => {
    const s = await session();
    const r = await evaluateBrowserAssertion({ visible: '.order-confirmed' }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('.order-confirmed');
  }, 60000);

  it('hidden passes for a hidden element', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ hidden: '.order-confirmed' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('url_matches honours a regex', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ url_matches: '/127\\.0\\.0\\.1/' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('text_matches searches the page text', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ text_matches: '/order desk/i' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('no_console_errors passes on a clean page', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ no_console_errors: true }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('no_console_errors fails and reports the message', async () => {
    const s = await session();
    await s.page.evaluate(() => console.error('kaboom-in-page'));
    await s.page.waitForTimeout(200);
    const r = await evaluateBrowserAssertion({ no_console_errors: true }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('kaboom-in-page');
  }, 60000);

  it('no_failed_requests passes when nothing failed', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ no_failed_requests: true }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('throws on a terminal-only assertion', async () => {
    const s = await session();
    await expect(evaluateBrowserAssertion({ process_alive: true }, s)).rejects.toThrow(/terminal/i);
  }, 60000);
});
