import { describe, it, expect } from 'vitest';
import {
  scanTerminalText,
  scanBrowserText,
  detectBlankFrame,
  detectFlatline,
  detectDurationAnomaly,
} from './heuristics.js';

const rgba = (w: number, h: number, fill: number) => Buffer.alloc(w * h * 4, fill);

describe('scanTerminalText', () => {
  it('flags a stack trace', () => {
    const f = scanTerminalText('boot', 'ok\nError: connect ECONNREFUSED\n  at Foo');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]!.code).toBe('H001');
    expect(f.map((x) => x.detail).join(' ')).toContain('ECONNREFUSED');
  });

  it('flags a command-not-found', () => {
    expect(scanTerminalText('x', 'bash: nope: command not found')).toHaveLength(1);
  });

  it('flags a non-zero npm exit', () => {
    expect(scanTerminalText('x', 'npm ERR! code ELIFECYCLE')).toHaveLength(1);
  });

  it('does not flag ordinary output', () => {
    expect(scanTerminalText('x', 'listening on :3000\nPOST /api/orders 201')).toEqual([]);
  });

  it('does not flag the word error inside a normal sentence', () => {
    expect(scanTerminalText('x', 'no errors found')).toEqual([]);
  });
});

describe('scanBrowserText', () => {
  it('flags a framework error overlay', () => {
    expect(scanBrowserText('order', 'Unhandled Runtime Error')).toHaveLength(1);
  });

  it('flags a server error page', () => {
    expect(scanBrowserText('order', '500 Internal Server Error')).toHaveLength(1);
  });

  it('ignores ordinary page copy', () => {
    expect(scanBrowserText('order', 'Order confirmed - 24 unit(s).')).toEqual([]);
  });
});

describe('detectBlankFrame', () => {
  it('flags a frame that is a single flat colour', () => {
    const f = detectBlankFrame('order', rgba(64, 64, 0));
    expect(f?.code).toBe('H002');
  });

  it('accepts a frame with real variation', () => {
    const buf = rgba(64, 64, 0);
    for (let i = 0; i < buf.length; i += 4) buf[i] = (i / 4) % 256;
    expect(detectBlankFrame('order', buf)).toBeNull();
  });
});

describe('detectFlatline', () => {
  it('flags frames that never change', () => {
    const same = rgba(32, 32, 7);
    const f = detectFlatline('order', [same, same, same, same]);
    expect(f?.code).toBe('H003');
  });

  it('accepts frames that differ', () => {
    const frames = [rgba(32, 32, 1), rgba(32, 32, 90), rgba(32, 32, 180)];
    expect(detectFlatline('order', frames)).toBeNull();
  });

  it('says nothing about a single frame', () => {
    expect(detectFlatline('order', [rgba(32, 32, 5)])).toBeNull();
  });
});

describe('detectDurationAnomaly', () => {
  it('flags a scene far longer than its peers', () => {
    const f = detectDurationAnomaly([
      { id: 'a', sec: 3 },
      { id: 'b', sec: 4 },
      { id: 'c', sec: 60 },
    ]);
    expect(f.map((x) => x.scene)).toContain('c');
    expect(f[0]!.code).toBe('H004');
  });

  it('accepts scenes of similar length', () => {
    expect(
      detectDurationAnomaly([
        { id: 'a', sec: 3 },
        { id: 'b', sec: 4 },
        { id: 'c', sec: 5 },
      ]),
    ).toEqual([]);
  });

  it('flags a hang even with only two scenes', () => {
    // Aborting on the first failure often leaves exactly two scenes, and
    // a plain median of two would hide the outlier inside itself.
    const f = detectDurationAnomaly([
      { id: 'boot', sec: 4.0 },
      { id: 'order', sec: 37.7 },
    ]);
    expect(f.map((x) => x.scene)).toEqual(['order']);
  });

  it('says nothing about a single scene', () => {
    expect(detectDurationAnomaly([{ id: 'a', sec: 90 }])).toEqual([]);
  });

  it('does not flag the short scene as anomalous', () => {
    const f = detectDurationAnomaly([
      { id: 'boot', sec: 4.0 },
      { id: 'order', sec: 37.7 },
    ]);
    expect(f.map((x) => x.scene)).not.toContain('boot');
  });
});

describe('H004 does not cry wolf on short scenes', () => {
  it('ignores a scene that is only slow relative to assertion-only ones', () => {
    // Measured on a real cold-start demo: three scenes did no work at all
    // (0s, assertions only), so the median was 0.4s and two scenes doing
    // their JOB were flagged as possible hangs. An agent reading that
    // report would chase two non-problems.
    const findings = detectDurationAnomaly([
      { id: 'boot', sec: 2.731 },
      { id: 'open', sec: 0.802 },
      { id: 'deploy', sec: 2.656 },
      { id: 'logged', sec: 0 },
      { id: 'proof', sec: 0 },
    ]);
    expect(findings).toEqual([]);
  });

  it('still catches a scene that is slow in absolute terms', () => {
    const findings = detectDurationAnomaly([
      { id: 'quick', sec: 2 },
      { id: 'hung', sec: 45 },
      { id: 'also-quick', sec: 2.5 },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.scene).toBe('hung');
  });

  it('needs BOTH conditions, not either', () => {
    // 100x the median but only 3s: not a hang, whatever the ratio says.
    expect(detectDurationAnomaly([
      { id: 'a', sec: 0.03 },
      { id: 'b', sec: 3 },
      { id: 'c', sec: 0.03 },
    ])).toEqual([]);

    // Slow in absolute terms but in line with its peers: also not a hang.
    expect(detectDurationAnomaly([
      { id: 'a', sec: 20 },
      { id: 'b', sec: 22 },
      { id: 'c', sec: 21 },
    ])).toEqual([]);
  });
});
