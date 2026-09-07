import { describe, it, expect, afterEach } from 'vitest';
import { openTerminalSession, type TerminalSession } from './session.js';
import { executeStep, type StepContext } from './steps.js';

const CLI = 'fixtures/cli-app/cli.mjs';
const open: TerminalSession[] = [];

async function ctx(): Promise<StepContext> {
  const session = await openTerminalSession({ cols: 80, rows: 24 });
  open.push(session);
  return { session, seed: 'test', typingSpeedMs: 5, settleMs: 10, now: () => Date.now() };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

describe('executeStep', () => {
  it('types text without submitting it', async () => {
    const c = await ctx();
    const r = await executeStep({ type: 'echo typed-marker' }, c);
    expect(r.ok).toBe(true);
    // Wait for the echo rather than assuming it is instant: the shell
    // echoes asynchronously, and reading immediately made this the
    // flakiest test in the suite under load.
    expect(await c.session.waitFor(/echo typed-marker/, 15000)).toBe(true);
  }, 30000);

  it('key Enter submits the typed line', async () => {
    const c = await ctx();
    await executeStep({ type: `"${process.execPath}" ${CLI} greet enter-works` }, c);
    await executeStep({ key: 'Enter' }, c);
    expect(await c.session.waitFor(/hello enter-works/, 15000)).toBe(true);
  }, 30000);

  it('wait_for resolves when stdout matches', async () => {
    const c = await ctx();
    await executeStep({ type: `"${process.execPath}" ${CLI} build` }, c);
    await executeStep({ key: 'Enter' }, c);
    const r = await executeStep({ wait_for: { stdout: '/build complete/' } }, c);
    expect(r.ok).toBe(true);
  }, 40000);

  it('wait_for fails with a useful detail when the pattern never appears', async () => {
    const c = await ctx();
    const r = await executeStep({ wait_for: { stdout: '/never-ever-appears/', timeout: 800 } }, c);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('never-ever-appears');
  }, 20000);

  it('run executes a command and waits for it to finish', async () => {
    const c = await ctx();
    const r = await executeStep({ run: `"${process.execPath}" ${CLI} greet ran` }, c);
    expect(r.ok).toBe(true);
    expect(await c.session.text()).toContain('hello ran');
  }, 30000);

  it('sleep waits roughly the requested time', async () => {
    const c = await ctx();
    const r = await executeStep({ sleep: 300 }, c);
    expect(r.endedAt - r.startedAt).toBeGreaterThanOrEqual(250);
  }, 20000);

  it('rejects an unknown key name with the list of known keys', async () => {
    const c = await ctx();
    const r = await executeStep({ key: 'Meta' }, c);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Enter');
  }, 20000);

  it('throws on a browser-only step, which lint should have caught', async () => {
    const c = await ctx();
    await expect(executeStep({ goto: 'http://x' }, c)).rejects.toThrow(/browser/i);
  }, 20000);
});
