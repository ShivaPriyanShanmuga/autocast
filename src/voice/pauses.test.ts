import { describe, it, expect } from 'vitest';
import { splitPauses, PAUSE_MARK, DEFAULT_PAUSE_SEC, MAX_PAUSE_SEC } from './pauses.js';

describe('splitPauses', () => {
  it('leaves ordinary narration as one part', () => {
    expect(splitPauses('First we start the server.')).toEqual([
      { text: 'First we start the server.', pauseAfterSec: 0 },
    ]);
  });

  it('splits on the pause mark and holds silence between', () => {
    // Measured: Kokoro gives the same ~0.30s break for a comma, a full
    // stop, an ellipsis, a dash or no punctuation at all. Punctuation
    // cannot place a pause, so the pause has to be real silence between
    // separately synthesized parts.
    expect(splitPauses('One click ships it. || The stages go green.')).toEqual([
      { text: 'One click ships it.', pauseAfterSec: DEFAULT_PAUSE_SEC },
      { text: 'The stages go green.', pauseAfterSec: 0 },
    ]);
  });

  it('takes an explicit duration', () => {
    expect(splitPauses('Watch this. ||1.5 Done.')).toEqual([
      { text: 'Watch this.', pauseAfterSec: 1.5 },
      { text: 'Done.', pauseAfterSec: 0 },
    ]);
  });

  it('handles several pauses', () => {
    const parts = splitPauses('a || b ||0.8 c');
    expect(parts.map((p) => p.text)).toEqual(['a', 'b', 'c']);
    expect(parts.map((p) => p.pauseAfterSec)).toEqual([DEFAULT_PAUSE_SEC, 0.8, 0]);
  });

  it('never leaves an empty part', () => {
    // A trailing or doubled mark is an authoring slip, not a reason to
    // synthesize an empty string — which the engine rejects outright.
    for (const text of ['hello ||', '|| hello', 'a |||| b', '  ||  ']) {
      for (const part of splitPauses(text)) expect(part.text.trim()).not.toBe('');
    }
  });

  it('clamps a silly duration rather than stalling the video', () => {
    expect(splitPauses('a ||999 b')[0]!.pauseAfterSec).toBe(MAX_PAUSE_SEC);
    expect(splitPauses('a ||-5 b')[0]!.pauseAfterSec).toBe(0);
  });

  it('reports the total silence it will add', () => {
    // The narration floor has to reserve room for the pauses too, or the
    // scene cuts away mid-sentence.
    const parts = splitPauses('a ||0.5 b ||0.25 c');
    const total = parts.reduce((n, p) => n + p.pauseAfterSec, 0);
    expect(total).toBeCloseTo(0.75, 6);
  });

  it('exposes the mark it splits on', () => {
    expect(PAUSE_MARK).toBe('||');
  });
});
