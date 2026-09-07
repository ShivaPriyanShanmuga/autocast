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
  }, 30_000);

  it('skips the library checks rather than claiming they are unavailable', async () => {
    const results = await runChecks(CHECKS);
    for (const name of ['libx264', 'librubberband']) {
      const r = byName(results, name);
      expect(r.status, `${name} should be skipped, not asserted`).toBe('skip');
      expect(r.detail).toContain('cannot check');
    }
  }, 30_000);

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
  }, 30_000);

  it('fails libx264 when the build lacks it', async () => {
    mocked.mockResolvedValue(info(['librubberband']));
    const r = byName(await runChecks(CHECKS), 'libx264');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('without libx264');
  }, 30_000);

  it('warns on librubberband when the build lacks it', async () => {
    mocked.mockResolvedValue(info(['libx264']));
    const r = byName(await runChecks(CHECKS), 'librubberband');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not enabled');
  });
});

describe('node-pty check', () => {
  it('is registered in the default check list', () => {
    expect(CHECKS.map((c) => c.name)).toContain('node-pty');
  });

  it('reports ok when a terminal can actually be opened', async () => {
    // Loading the binding is not enough: on macOS CI the module loaded
    // and every spawn failed. This check opens a real PTY.
    const check = CHECKS.find((c) => c.name === 'node-pty')!;
    const r = await check.run();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/\d+\.\d+\.\d+/);
  }, 30000);

  it('names the resolved shell, so a spawn failure is diagnosable', async () => {
    const check = CHECKS.find((c) => c.name === 'node-pty')!;
    const r = await check.run();
    expect(r.detail).toMatch(/\(.+\)/);
  }, 30000);
});

describe('chromium check', () => {
  it('is registered in the default check list', () => {
    expect(CHECKS.map((c) => c.name)).toContain('chromium');
  });

  it('reports ok when the browser binary exists', async () => {
    const check = CHECKS.find((c) => c.name === 'chromium')!;
    const r = await check.run();
    expect(r.status).toBe('ok');
  });

  it('names the install command when it is missing', async () => {
    const check = CHECKS.find((c) => c.name === 'chromium')!;
    const r = await check.run();
    if (r.status !== 'ok') {
      expect(r.hint).toContain('playwright install chromium');
    }
  });
});

describe('voice check', () => {
  const voice = () => CHECKS.find((c) => c.name === 'voice (kokoro)')!;

  it('is registered', () => {
    expect(voice()).toBeDefined();
  });

  it('never fails, because voice is opt-in', async () => {
    // A demo that does not ask to speak is not broken for lacking a
    // speech engine. Reporting `fail` would make `doctor` red for
    // everyone rendering silent demos.
    const r = await voice().run();
    expect(['ok', 'skip']).toContain(r.status);
  }, 30_000);

  it('names the install command when it is not there', async () => {
    const r = await voice().run();
    if (r.status === 'skip') {
      expect(r.hint).toContain('npm i -D kokoro-js');
    } else {
      expect(r.detail).toMatch(/models in/);
    }
  }, 30_000);
});
