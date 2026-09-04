/**
 * Deterministic PRNG (mulberry32) seeded from a string. Spec section 7.2
 * wants typing that feels human but re-renders identically, so every
 * random choice has to come from a reproducible source.
 */
export function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KeyStroke {
  char: string;
  /** How long to wait AFTER emitting this character. */
  delayMs: number;
}

export interface TypingOptions {
  seed: string;
  baseMs: number;
}

/** Characters that earn a longer beat, as a real typist would pause. */
const BEAT_AFTER = new Set(['.', ',', ':', ';', '!', '?', ' ']);

/** Box-Muller, clamped, so jitter is Gaussian rather than uniform. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2, Math.min(2, n)) / 2; // roughly [-1, 1]
}

export function planTyping(text: string, opts: TypingOptions): KeyStroke[] {
  const rng = makeRng(opts.seed);
  const strokes: KeyStroke[] = [];

  for (const char of text) {
    const jitter = 1 + gaussian(rng) * 0.3; // +/-30%
    const beat = BEAT_AFTER.has(char) ? 1.6 : 1;
    const delay = Math.round(opts.baseMs * jitter * beat);
    strokes.push({ char, delayMs: Math.max(1, Math.min(delay, opts.baseMs * 2)) });
  }

  return strokes;
}
