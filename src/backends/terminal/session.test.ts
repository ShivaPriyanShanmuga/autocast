import { describe, it, expect, afterEach } from 'vitest';
import { openTerminalSession, type TerminalSession } from './session.js';

const CLI = 'fixtures/cli-app/cli.mjs';
const open: TerminalSession[] = [];

async function session(cols = 80, rows = 24) {
  const s = await openTerminalSession({ cols, rows });
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

describe('TerminalSession', () => {
  it('runs a command and exposes its rendered output', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet world\r`);
    // Wait on the LAST line the command prints, then assert on an earlier
    // one. Waiting on "hello world" and then reading text() for "ready"
    // would race: waitFor returns the instant its pattern appears.
    expect(await s.waitFor(/ready/, 15000)).toBe(true);
    expect(await s.text()).toContain('hello world');
  }, 30000);

  it('strips ANSI escapes from the text view', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet world\r`);
    await s.waitFor(/ready/, 15000);
    expect(await s.text()).not.toContain('\x1b');
  }, 30000);

  it('resolves a carriage-return progress bar to its final state', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} build\r`);
    expect(await s.waitFor(/build complete/, 20000)).toBe(true);
    const text = await s.text();
    expect(text).toContain('100%');
    // The bar redraws in place: intermediate percentages must not survive.
    expect(text).not.toContain('10%\n');
  }, 30000);

  it('records an asciicast with events', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet world\r`);
    await s.waitFor(/ready/, 15000);
    const cast = s.cast();
    expect(cast.version).toBe(2);
    expect(cast.width).toBe(80);
    expect(cast.events.length).toBeGreaterThan(0);
    expect(cast.events.map((e) => e[2]).join('')).toContain('hello');
  }, 30000);

  it('returns false when a pattern never appears', async () => {
    const s = await session();
    expect(await s.waitFor(/this-never-appears/, 1200)).toBe(false);
  }, 20000);

  it('kills a process that never exits, without AttachConsole noise', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} watch\r`);
    expect(await s.waitFor(/listening on :4242/, 15000)).toBe(true);
    expect(s.isAlive()).toBe(true);
    await s.dispose();
    expect(s.isAlive()).toBe(false);
  }, 30000);

  it('dispose is idempotent', async () => {
    const s = await session();
    await s.dispose();
    await expect(s.dispose()).resolves.toBeUndefined();
  }, 20000);
});
