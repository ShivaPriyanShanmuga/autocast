import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('autocast validate', () => {
  it('exits 0 on the flagship fixture', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/mixed/demo.yaml'], c.io);
    expect(code).toBe(0);
  });

  it('exits 1 and names the file, line and reason on a broken fixture', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/broken/undeclared-session.yaml'], c.io);
    expect(code).toBe(1);
    expect(c.out()).toContain('fixtures/broken/undeclared-session.yaml:9');
    expect(c.out()).toContain('L001');
    expect(c.out()).toContain('not declared');
  });

  it('exits 2 when the file does not exist', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/nope.yaml'], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('cannot read');
  });

  it('exits 2 when no file is given', async () => {
    const c = captureIO();
    const code = await runCli(['validate'], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain('expects a file');
  });

  it('exits 0 on a warnings-only file by default', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/warnings/no-assertions.yaml'], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain('L004');
  });

  it('exits 1 on the same warnings-only file when --strict is passed', async () => {
    const c = captureIO();
    const code = await runCli(
      ['validate', '--strict', 'fixtures/warnings/no-assertions.yaml'],
      c.io,
    );
    expect(code).toBe(1);
  });
});
