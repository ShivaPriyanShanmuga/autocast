import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('Phase 0 exit criteria', () => {
  it('doctor reports every check with a status', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    for (const name of ['ffmpeg', 'libx264', 'librubberband', 'cwd writable']) {
      expect(c.out()).toContain(name);
    }
  });

  it('doctor gives an actionable hint for anything not OK', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    const text = c.out();
    if (text.includes('FAIL') || text.includes('WARN')) {
      expect(text).toMatch(/install|unavailable|writes/i);
    }
  });

  it('validate passes the flagship fixture', async () => {
    const c = captureIO();
    expect(await runCli(['validate', 'fixtures/mixed/demo.yaml'], c.io)).toBe(0);
  });

  it('validate fails a broken fixture, naming the line and the reason', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/broken/undeclared-session.yaml'], c.io);
    expect(code).toBe(1);
    expect(c.out()).toMatch(/undeclared-session\.yaml:\d+:\d+/);
    expect(c.out()).toContain('not declared');
  });

  it('every broken fixture is rejected', async () => {
    for (const f of ['undeclared-session', 'bad-regex', 'wrong-backend', 'yaml-syntax']) {
      const c = captureIO();
      const code = await runCli(['validate', `fixtures/broken/${f}.yaml`], c.io);
      expect(code, `fixtures/broken/${f}.yaml should fail`).toBe(1);
    }
  });

  it('carries no rendering or encoding dependency yet', () => {
    // Phase 1a adds the PTY pair. Canvas, ffmpeg bindings and Playwright
    // belong to later phases; their appearance here means scope crept.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@xterm/headless',
      'node-pty',
      'yaml',
      'zod',
    ]);
  });
});
