import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';
import { executeBrowserStep } from './steps.js';

const PORT = 34571;
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

async function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'autodemo-ct-'));
  dirs.push(dir);
  const session = await openBrowserSession({
    viewport: [640, 400],
    framesDir: join(dir, 'frames'),
  });
  open.push(session);
  return { session, settleMs: 30, now: () => Date.now() };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('pointer tracking', () => {
  it('starts empty', async () => {
    const c = await ctx();
    expect(c.session.pointerTrack()).toEqual([]);
  }, 60000);

  it('records a keyframe at the centre of a clicked element', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);

    const track = c.session.pointerTrack();
    expect(track.length).toBeGreaterThan(0);
    const last = track[track.length - 1]!;
    expect(last.click).toBe(true);
    expect(last.at.x).toBeGreaterThan(0);
    expect(last.at.y).toBeGreaterThan(0);
    expect(last.at.x).toBeLessThan(640);
  }, 60000);

  it('uses unix seconds, matching the frame clock', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    const t = c.session.pointerTrack()[0]!.tSec;
    expect(t).toBeGreaterThan(1_000_000_000);
    expect(t).toBeLessThan(100_000_000_000);
  }, 60000);

  it('records a non-click keyframe for fill', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    const before = c.session.pointerTrack().length;
    await executeBrowserStep({ fill: { selector: '#qty', value: '4' } }, c);
    expect(c.session.pointerTrack().length).toBeGreaterThan(before);
  }, 60000);

  it('records keyframes in increasing time order', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    await executeBrowserStep({ fill: { selector: '#qty', value: '2' } }, c);
    const ts = c.session.pointerTrack().map((k) => k.tSec);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
  }, 60000);
});
