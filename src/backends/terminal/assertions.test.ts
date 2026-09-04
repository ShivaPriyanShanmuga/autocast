import { describe, it, expect, afterEach } from 'vitest';
import { openTerminalSession, type TerminalSession } from './session.js';
import { evaluateAssertion } from './assertions.js';

const CLI = 'fixtures/cli-app/cli.mjs';
const open: TerminalSession[] = [];

async function session() {
  const s = await openTerminalSession({ cols: 80, rows: 24 });
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

describe('evaluateAssertion', () => {
  it('stdout_contains passes when the text is present', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet asserted\r`);
    await s.waitFor(/ready/, 15000);
    expect(await evaluateAssertion({ stdout_contains: 'hello asserted' }, s)).toMatchObject({
      ok: true,
    });
  }, 30000);

  it('stdout_contains fails with the tail of the output as detail', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} greet asserted\r`);
    await s.waitFor(/ready/, 15000);
    const r = await evaluateAssertion({ stdout_contains: 'not-in-the-output' }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('hello asserted');
  }, 30000);

  it('stdout_matches honours a regex', async () => {
    const s = await session();
    s.write(`"${process.execPath}" ${CLI} build\r`);
    await s.waitFor(/build complete/, 20000);
    expect(await evaluateAssertion({ stdout_matches: '/\\[#+-*\\] +100%/' }, s)).toMatchObject({
      ok: true,
    });
  }, 40000);

  it('process_alive is true for a live shell', async () => {
    const s = await session();
    expect(await evaluateAssertion({ process_alive: true }, s)).toMatchObject({ ok: true });
  }, 20000);

  it('process_alive: false fails while the shell is still running', async () => {
    const s = await session();
    expect(await evaluateAssertion({ process_alive: false }, s)).toMatchObject({ ok: false });
  }, 20000);

  it('stderr_empty reports honestly that a PTY cannot answer it', async () => {
    const s = await session();
    const r = await evaluateAssertion({ stderr_empty: true }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/merges stdout and stderr/i);
  }, 20000);

  it('exit_code reports that the process is still running', async () => {
    const s = await session();
    const r = await evaluateAssertion({ exit_code: 0 }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('still running');
  }, 20000);

  it('throws on a browser-only assertion', async () => {
    const s = await session();
    await expect(evaluateAssertion({ visible: '.x' }, s)).rejects.toThrow(/browser/i);
  }, 20000);
});
