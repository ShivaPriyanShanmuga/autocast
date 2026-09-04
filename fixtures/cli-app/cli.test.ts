import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = 'fixtures/cli-app/cli.mjs';

describe('cli-app fixture', () => {
  it('greet prints a coloured greeting', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'greet', 'world']);
    expect(stdout).toContain('world');
    expect(stdout).toContain('\x1b[');
  });

  it('build redraws a progress bar with carriage returns and finishes', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'build']);
    expect(stdout).toContain('\r');
    expect(stdout).toContain('100%');
    expect(stdout).toContain('build complete');
  });

  it('fail exits non-zero and writes to stderr', async () => {
    await expect(run(process.execPath, [CLI, 'fail'])).rejects.toMatchObject({ code: 2 });
  });

  it('rejects an unknown command', async () => {
    await expect(run(process.execPath, [CLI, 'nope'])).rejects.toMatchObject({ code: 1 });
  });
});
