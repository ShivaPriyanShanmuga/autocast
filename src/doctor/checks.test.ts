import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ffmpeg.js', () => ({ probeFfmpeg: vi.fn() }));

import { probeFfmpeg, type FfmpegInfo } from './ffmpeg.js';
import { CHECKS, runChecks, type CheckResult } from './checks.js';

const mocked = vi.mocked(probeFfmpeg);

function byName(results: CheckResult[], name: string): CheckResult {
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`no check named ${name}`);
  return r;
}

const info = (libs: string[]): FfmpegInfo => ({ version: '7.1.1', libs: new Set(libs) });

beforeEach(() => mocked.mockReset());

describe('dependency checks when ffmpeg is missing', () => {
  beforeEach(() => mocked.mockResolvedValue(null));

  it('fails the ffmpeg check with an install hint', async () => {
    const r = byName(await runChecks(CHECKS), 'ffmpeg');
    expect(r.status).toBe('fail');
    expect(r.hint).toContain('apt install ffmpeg');
  });

  it('skips the library checks rather than claiming they are unavailable', async () => {
    const results = await runChecks(CHECKS);
    for (const name of ['libx264', 'librubberband']) {
      const r = byName(results, name);
      expect(r.status, `${name} should be skipped, not asserted`).toBe('skip');
      expect(r.detail).toContain('cannot check');
    }
  });

  it('does not repeat the ffmpeg install instructions on dependent checks', async () => {
    const results = await runChecks(CHECKS);
    const withInstallHint = results.filter((r) => r.hint?.includes('apt install ffmpeg'));
    expect(withInstallHint).toHaveLength(1);
  });
});

describe('dependency checks when ffmpeg is present', () => {
  it('passes when every library is enabled', async () => {
    mocked.mockResolvedValue(info(['libx264', 'librubberband']));
    const results = await runChecks(CHECKS);
    expect(byName(results, 'ffmpeg').status).toBe('ok');
    expect(byName(results, 'libx264').status).toBe('ok');
    expect(byName(results, 'librubberband').status).toBe('ok');
  });

  it('fails libx264 when the build lacks it', async () => {
    mocked.mockResolvedValue(info(['librubberband']));
    const r = byName(await runChecks(CHECKS), 'libx264');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('without libx264');
  });

  it('warns on librubberband when the build lacks it', async () => {
    mocked.mockResolvedValue(info(['libx264']));
    const r = byName(await runChecks(CHECKS), 'librubberband');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not enabled');
  });
});
