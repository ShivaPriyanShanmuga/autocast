import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';
import { executeBrowserStep, type BrowserStepContext } from './steps.js';

const PORT = 34569;
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

async function ctx(): Promise<BrowserStepContext> {
  const dir = mkdtempSync(join(tmpdir(), 'autodemo-bsteps-'));
  dirs.push(dir);
  const session = await openBrowserSession({
    viewport: [640, 400],
    framesDir: join(dir, 'frames'),
  });
  open.push(session);
  return { session, settleMs: 50, now: () => Date.now() };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('executeBrowserStep', () => {
  it('goto loads the page', async () => {
    const c = await ctx();
    const r = await executeBrowserStep({ goto: BASE }, c);
    expect(r.ok).toBe(true);
    expect(c.session.page.url()).toContain(String(PORT));
  }, 60000);

  it('click activates an element', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    const r = await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    expect(r.ok).toBe(true);
    expect(await c.session.page.locator('[data-test=order-form]').isVisible()).toBe(true);
  }, 60000);

  it('fill sets an input value', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    const r = await executeBrowserStep({ fill: { selector: '#qty', value: '7' } }, c);
    expect(r.ok).toBe(true);
    expect(await c.session.page.locator('#qty').inputValue()).toBe('7');
  }, 60000);

  it('wait_for resolves when a selector appears', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    await executeBrowserStep({ fill: { selector: '#qty', value: '2' } }, c);
    await executeBrowserStep({ click: '#submit' }, c);
    const r = await executeBrowserStep({ wait_for: { selector: '.order-confirmed' } }, c);
    expect(r.ok).toBe(true);
  }, 60000);

  it('click fails with a useful detail when the selector is missing', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    const r = await executeBrowserStep(
      { click: '#does-not-exist' },
      { ...c, settleMs: 10, actionTimeoutMs: 1000 },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('#does-not-exist');
  }, 60000);

  it('wait_for fails with a timeout detail', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    const r = await executeBrowserStep(
      { wait_for: { selector: '.never-appears', timeout: 800 } },
      c,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('.never-appears');
  }, 60000);

  it('throws on a terminal-only step, which lint should have caught', async () => {
    const c = await ctx();
    await expect(executeBrowserStep({ run: 'ls' }, c)).rejects.toThrow(/terminal/i);
  }, 60000);
});
