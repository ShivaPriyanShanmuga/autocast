import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';
import { formatCheckResults } from './doctor-command.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('formatCheckResults', () => {
  it('marks passing checks and reports success', () => {
    const text = formatCheckResults([{ name: 'ffmpeg', status: 'ok', detail: '7.1.1' }]);
    expect(text).toContain('ffmpeg');
    expect(text).toContain('7.1.1');
    expect(text).toContain('all checks passed');
  });

  it('prints the hint for a failing check', () => {
    const text = formatCheckResults([
      {
        name: 'ffmpeg',
        status: 'fail',
        detail: 'not found on PATH',
        hint: '    brew install ffmpeg',
      },
    ]);
    expect(text).toContain('not found on PATH');
    expect(text).toContain('brew install ffmpeg');
  });

  it('distinguishes a warning from a failure', () => {
    const text = formatCheckResults([
      { name: 'librubberband', status: 'warn', detail: 'not available', hint: '    ok for silent' },
    ]);
    expect(text).toContain('1 warning');
    expect(text).not.toContain('1 failed');
  });
});

describe('autocast doctor', () => {
  it('runs and returns 0 or 1 without throwing', async () => {
    const c = captureIO();
    const code = await runCli(['doctor'], c.io);
    expect([0, 1]).toContain(code);
    expect(c.out()).toContain('ffmpeg');
  });
});
