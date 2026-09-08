import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, cachedPath, synthesizeCached } from './cache.js';
import { FakeVoice } from './fake.js';
import type { SynthesisRequest, SynthesisResult, VoiceBackend } from './backend.js';

const dir = mkdtempSync(join(tmpdir(), 'autodemo-vcache-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const req = (over: Partial<SynthesisRequest> = {}): SynthesisRequest => ({
  text: 'First we start the order API.',
  voice: 'af_heart',
  rate: 1,
  ...over,
});

/** Wraps a backend and counts how often it was actually asked to speak. */
class Counting implements VoiceBackend {
  readonly name: string;
  calls = 0;
  constructor(private readonly inner: VoiceBackend) {
    this.name = inner.name;
  }
  synthesize(r: SynthesisRequest, out: string): Promise<SynthesisResult> {
    this.calls++;
    return this.inner.synthesize(r, out);
  }
}

describe('cacheKey', () => {
  it('is stable for the same request', () => {
    expect(cacheKey('kokoro', req())).toBe(cacheKey('kokoro', req()));
  });

  it('changes with text, voice, rate and backend', () => {
    const base = cacheKey('kokoro', req());
    expect(cacheKey('kokoro', req({ text: 'other' }))).not.toBe(base);
    expect(cacheKey('kokoro', req({ voice: 'af_nova' }))).not.toBe(base);
    expect(cacheKey('kokoro', req({ rate: 1.1 }))).not.toBe(base);
    // The same words in a different engine are different audio.
    expect(cacheKey('fake', req())).not.toBe(base);
  });

  it('is a filesystem-safe hex digest', () => {
    expect(cacheKey('kokoro', req())).toMatch(/^[0-9a-f]{16,}$/);
  });
});

describe('synthesizeCached', () => {
  it('synthesizes once and reuses the result', async () => {
    // At 3-5x realtime, re-synthesising every render would make the CI
    // re-render the spec promises cost minutes.
    const backend = new Counting(new FakeVoice());
    const a = await synthesizeCached(backend, req(), dir);
    const b = await synthesizeCached(backend, req(), dir);
    expect(backend.calls).toBe(1);
    expect(b.wavPath).toBe(a.wavPath);
    expect(b.durationSec).toBeCloseTo(a.durationSec, 5);
  }, 30_000);

  it('synthesizes again for a different request', async () => {
    const backend = new Counting(new FakeVoice());
    await synthesizeCached(backend, req({ text: 'one' }), dir);
    await synthesizeCached(backend, req({ text: 'two' }), dir);
    expect(backend.calls).toBe(2);
  }, 30_000);

  it('re-synthesizes a zero-byte entry rather than trusting it', async () => {
    // A render interrupted mid-write leaves a truncated file. Trusting it
    // would produce a silent demo with no error anywhere.
    const backend = new Counting(new FakeVoice());
    const r = req({ text: 'truncated entry' });
    writeFileSync(cachedPath(dir, cacheKey(backend.name, r)), '');
    const result = await synthesizeCached(backend, r, dir);
    expect(backend.calls).toBe(1);
    expect(result.durationSec).toBeGreaterThan(0);
  }, 30_000);

  it('reports a duration measured from the file, not assumed', async () => {
    const backend = new FakeVoice();
    const r = req({ text: 'measure me please' });
    const fresh = await synthesizeCached(backend, r, dir);
    const cached = await synthesizeCached(backend, r, dir);
    expect(cached.durationSec).toBeCloseTo(fresh.durationSec, 2);
    expect(existsSync(cached.wavPath)).toBe(true);
  }, 30_000);
});
