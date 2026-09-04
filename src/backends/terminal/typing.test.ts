import { describe, it, expect } from 'vitest';
import { makeRng, planTyping } from './typing.js';

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng('boot');
    const b = makeRng('boot');
    expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()]);
  });

  it('differs between seeds', () => {
    expect(makeRng('boot')()).not.toBe(makeRng('order')());
  });

  it('stays within [0, 1)', () => {
    const r = makeRng('x');
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('planTyping', () => {
  const opts = { seed: 'boot', baseMs: 45 };

  it('produces one stroke per character', () => {
    const plan = planTyping('npm run dev', opts);
    expect(plan.map((k) => k.char).join('')).toBe('npm run dev');
  });

  it('is reproducible', () => {
    expect(planTyping('npm run dev', opts)).toEqual(planTyping('npm run dev', opts));
  });

  it('varies delays rather than emitting a constant rhythm', () => {
    const delays = new Set(planTyping('aaaaaaaaaa', opts).map((k) => k.delayMs));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('keeps every delay positive and within 2x the base', () => {
    for (const k of planTyping('hello, world. bye', opts)) {
      expect(k.delayMs).toBeGreaterThan(0);
      expect(k.delayMs).toBeLessThanOrEqual(opts.baseMs * 2 + 1);
    }
  });

  it('pauses longer after punctuation than after letters, on average', () => {
    // Comparing two individual strokes would be flaky: a letter jittered
    // +30% can out-wait a period jittered -30%. The beat is a distribution
    // shift, so assert on the distribution.
    const plan = planTyping('ab. cd. ef. gh. ij. kl. mn. op. qr. st.', {
      seed: 's',
      baseMs: 100,
    });
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const punct = mean(plan.filter((k) => k.char === '.').map((k) => k.delayMs));
    const letters = mean(plan.filter((k) => /[a-z]/.test(k.char)).map((k) => k.delayMs));
    expect(punct).toBeGreaterThan(letters);
  });

  it('handles an empty string', () => {
    expect(planTyping('', opts)).toEqual([]);
  });
});
