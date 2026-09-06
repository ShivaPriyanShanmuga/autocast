import { describe, it, expect } from 'vitest';
import { buildVtt, cuesFromPlan, formatTimestamp } from './vtt.js';
import type { CompositionPlan, SceneWindow } from './composition.js';

function window(over: Partial<SceneWindow> & { id: string }): SceneWindow {
  const outStartSec = over.outStartSec ?? 0;
  const outEndSec = over.outEndSec ?? outStartSec + 3;
  return {
    use: over.id,
    primary: over.id,
    inset: null,
    focus: null,
    zoomStartSec: null,
    narration: null,
    wallStartMs: 0,
    wallEndMs: 1000,
    segments: [{ outStartSec, outEndSec, wallStartMs: 0, wallEndMs: 1000 }],
    ...over,
    outStartSec,
    outEndSec,
  };
}

const plan = (windows: SceneWindow[]): CompositionPlan => ({
  windows,
  totalSec: windows[windows.length - 1]?.outEndSec ?? 0,
});

describe('formatTimestamp', () => {
  it('is zero-padded HH:MM:SS.mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00:00.000');
    expect(formatTimestamp(1.5)).toBe('00:00:01.500');
    expect(formatTimestamp(61.25)).toBe('00:01:01.250');
    expect(formatTimestamp(3661.007)).toBe('01:01:01.007');
  });

  it('never emits a negative time', () => {
    expect(formatTimestamp(-5)).toBe('00:00:00.000');
  });
});

describe('cuesFromPlan', () => {
  it('emits one cue per narrated scene, spanning its window', () => {
    const cues = cuesFromPlan(
      plan([
        window({ id: 'boot', outStartSec: 0, outEndSec: 5, narration: { text: 'Boot.', sec: 2 } }),
        window({ id: 'quiet', outStartSec: 5, outEndSec: 8 }),
        window({ id: 'done', outStartSec: 8, outEndSec: 12, narration: { text: 'Done.', sec: 1 } }),
      ]),
    );
    expect(cues).toEqual([
      { startSec: 0, endSec: 5, text: 'Boot.' },
      { startSec: 8, endSec: 12, text: 'Done.' },
    ]);
  });

  it('skips a narration with no text', () => {
    const cues = cuesFromPlan(
      plan([window({ id: 'a', narration: { text: '   ', sec: 2 } })]),
    );
    expect(cues).toEqual([]);
  });

  it('produces cues in order that never overlap', () => {
    const cues = cuesFromPlan(
      plan([
        window({ id: 'a', outStartSec: 0, outEndSec: 4, narration: { text: 'A', sec: 1 } }),
        window({ id: 'b', outStartSec: 4, outEndSec: 9, narration: { text: 'B', sec: 1 } }),
      ]),
    );
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.startSec).toBeGreaterThanOrEqual(cues[i - 1]!.endSec);
    }
  });
});

describe('buildVtt', () => {
  it('starts with the WEBVTT header', () => {
    expect(buildVtt([]).startsWith('WEBVTT\n')).toBe(true);
  });

  it('is still a valid file when there is nothing to say', () => {
    expect(buildVtt([]).trim()).toBe('WEBVTT');
  });

  it('writes each cue as a timing line and a text line', () => {
    const out = buildVtt([{ startSec: 0, endSec: 5, text: 'Boot.' }]);
    expect(out).toContain('00:00:00.000 --> 00:00:05.000');
    expect(out).toContain('Boot.');
  });

  it('cannot have its cue framing broken by a blank line in the text', () => {
    // A blank line terminates a cue in WebVTT, so narration containing
    // one would silently split into a cue and a stray fragment.
    const out = buildVtt([{ startSec: 0, endSec: 1, text: 'one\n\ntwo' }]);
    expect(out).not.toMatch(/\n\n\s*two/);
    expect(out).toContain('one two');
  });
});
