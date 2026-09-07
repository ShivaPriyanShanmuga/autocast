import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeVoice } from './fake.js';
import { speechDurationSec } from '../render/speech.js';
import { probeAudio } from './probe.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-fake-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const req = (text: string) => ({ text, voice: 'test', rate: 1 });

describe('FakeVoice', () => {
  it('writes a wav ffprobe recognises as audio', async () => {
    const v = new FakeVoice();
    const out = join(dir, 'a.wav');
    await v.synthesize(req('First we start the order API.'), out);
    const probe = await probeAudio(out);
    expect(probe.codec).toMatch(/pcm/);
    expect(probe.durationSec).toBeGreaterThan(0);
  }, 30_000);

  it('lasts as long as the word-count estimate says it should', async () => {
    // Every timing test downstream leans on this: a fake whose duration
    // did not match the estimate would make the floor untestable.
    const v = new FakeVoice();
    const text = 'A customer places an order for twenty-four units.';
    const out = join(dir, 'b.wav');
    const result = await v.synthesize(req(text), out);
    expect(result.durationSec).toBeCloseTo(speechDurationSec(text), 2);

    const probe = await probeAudio(out);
    expect(probe.durationSec).toBeCloseTo(speechDurationSec(text), 1);
  }, 30_000);

  it('is deterministic', async () => {
    const v = new FakeVoice();
    const a = join(dir, 'c1.wav');
    const b = join(dir, 'c2.wav');
    await v.synthesize(req('same words'), a);
    await v.synthesize(req('same words'), b);
    expect(Buffer.compare(readFileSync(a), readFileSync(b))).toBe(0);
  }, 30_000);

  it('refuses empty text rather than writing a zero-length wav', async () => {
    const v = new FakeVoice();
    await expect(v.synthesize(req('   '), join(dir, 'empty.wav'))).rejects.toThrow(/empty/i);
  });

  it('shortens the audio when the rate is raised', async () => {
    const v = new FakeVoice();
    const slow = await v.synthesize({ text: 'one two three', voice: 't', rate: 1 }, join(dir, 's.wav'));
    const fast = await v.synthesize({ text: 'one two three', voice: 't', rate: 2 }, join(dir, 'f.wav'));
    expect(fast.durationSec).toBeCloseTo(slow.durationSec / 2, 3);
    expect(statSync(join(dir, 'f.wav')).size).toBeLessThan(statSync(join(dir, 's.wav')).size);
  }, 30_000);
});
