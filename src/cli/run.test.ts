import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('runCli', () => {
  it('prints the version with --version', async () => {
    const c = captureIO();
    const code = await runCli(['--version'], c.io);
    expect(code).toBe(0);
    expect(c.out()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints usage with --help', async () => {
    const c = captureIO();
    const code = await runCli(['--help'], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain('castscript');
    expect(c.out()).toContain('validate');
  });

  it('prints usage and exits 2 when no command is given', async () => {
    const c = captureIO();
    const code = await runCli([], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('no command given');
  });

  it('exits 2 on an unknown command', async () => {
    const c = captureIO();
    const code = await runCli(['frobnicate'], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('unknown command "frobnicate"');
  });
});

describe('init in the CLI', () => {
  it('is listed in the usage text', async () => {
    const out: string[] = [];
    await runCli(['--help'], { out: (t) => out.push(t), err: () => {} });
    expect(out.join('')).toMatch(/init/);
  });
});
