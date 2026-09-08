import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from './run.js';

const dir = mkdtempSync(join(tmpdir(), 'autodemo-cli-render-'));
afterAll(() =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
);

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('autodemo render', () => {
  it('renders the terminal fixture to the requested path', async () => {
    const out = join(dir, 'cli.mp4');
    const c = captureIO();
    const code = await runCli(['render', 'fixtures/terminal/demo.yaml', '--out', out], c.io);
    expect(code, c.out() + c.err()).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(c.out()).toContain('greet');
    expect(c.out()).toContain('frames');
  }, 180000);

  it('refuses to render a script that fails validation', async () => {
    const c = captureIO();
    const code = await runCli(['render', 'fixtures/broken/undeclared-session.yaml'], c.io);
    expect(code).toBe(1);
    expect(c.out()).toContain('L001');
  }, 30000);

  it('exits 2 when the file is missing', async () => {
    const c = captureIO();
    expect(await runCli(['render', 'fixtures/nope.yaml'], c.io)).toBe(2);
    expect(c.err()).toContain('cannot read');
  }, 30000);

  it('exits 2 when no file is given', async () => {
    const c = captureIO();
    expect(await runCli(['render'], c.io)).toBe(2);
    expect(c.err()).toContain('expects a file');
  }, 30000);
});
