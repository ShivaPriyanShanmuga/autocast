import { describe, it, expect } from 'vitest';
import { speechDurationSec, countWords, DEFAULT_WPM } from './speech.js';

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('First we start the order API.')).toBe(6);
  });

  it('is zero for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });

  it('does not count punctuation or newlines as words', () => {
    expect(countWords('one,\ntwo.  three!')).toBe(3);
  });
});

describe('speechDurationSec', () => {
  it('is zero when there is nothing to say', () => {
    expect(speechDurationSec('')).toBe(0);
    expect(speechDurationSec('   ')).toBe(0);
  });

  it('matches words / wpm * 60', () => {
    // 150 words at 150 wpm is one minute, by construction.
    const text = Array.from({ length: 150 }, () => 'word').join(' ');
    expect(speechDurationSec(text)).toBeCloseTo(60, 5);
  });

  it('honours a custom rate', () => {
    const text = Array.from({ length: 30 }, () => 'word').join(' ');
    expect(speechDurationSec(text, 300)).toBeCloseTo(6, 5);
    expect(speechDurationSec(text, 60)).toBeCloseTo(30, 5);
  });

  it('uses 150 wpm by default', () => {
    const text = 'a b c d e';
    expect(speechDurationSec(text)).toBeCloseTo(speechDurationSec(text, DEFAULT_WPM), 10);
  });

  it('is finite and non-negative for pathological rates', () => {
    // A zero or negative rate would otherwise produce Infinity, and a
    // scene of infinite length is a hang, not a video.
    for (const wpm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = speechDurationSec('some words here', wpm);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it('agrees with the linter about what a word is', () => {
    // The linter warns on long narration and the planner reserves time
    // for it. If they disagreed, a warning would not predict a hold.
    const text = 'one,\ntwo.  three!';
    expect(speechDurationSec(text)).toBeCloseTo((3 / DEFAULT_WPM) * 60, 10);
  });
});
