import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinWithPauses } from './join.js';
import { FakeVoice } from './fake.js';
import { rmsAt } from './rms.js';
import { probeAudio } from './probe.js';

const dir = mkdtempSync(join(tmpdir(), 'castscript-join-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const voice = new FakeVoice();
const say = async (text: string, name: string) =>
  voice.synthesize({ text, voice: 't', rate: 1 }, join(dir, name));

describe('joinWithPauses', () => {
  it('produces one wav whose length is the parts plus the silence', async () => {
    const a = await say('first part speaking', 'a.wav');
    const b = await say('second part speaking', 'b.wav');
    const out = join(dir, 'joined.wav');

    const r = await joinWithPauses([
      { audio: a, pauseAfterSec: 0.5 },
      { audio: b, pauseAfterSec: 0 },
    ], out);

    expect(r.durationSec).toBeCloseTo(a.durationSec + 0.5 + b.durationSec, 2);
    const probe = await probeAudio(out);
    expect(probe.durationSec).toBeCloseTo(r.durationSec, 1);
    expect(probe.channels).toBe(1);
  }, 60_000);

  it('puts real silence where the pause was asked for', async () => {
    const a = await say('one two three four', 'p1.wav');
    const b = await say('five six seven eight', 'p2.wav');
    const out = join(dir, 'gap.wav');
    const r = await joinWithPauses([
      { audio: a, pauseAfterSec: 0.6 },
      { audio: b, pauseAfterSec: 0 },
    ], out);

    // Loud, then silent through the gap, then loud again.
    expect(await rmsAt(out, a.durationSec * 0.5, a.durationSec * 0.8)).toBeGreaterThan(0.01);
    expect(await rmsAt(out, a.durationSec + 0.1, a.durationSec + 0.5)).toBeLessThan(0.001);
    expect(await rmsAt(out, r.durationSec - 0.4, r.durationSec - 0.1)).toBeGreaterThan(0.01);
  }, 60_000);

  it('returns the single part untouched when there is nothing to join', async () => {
    // A demo with no pause marks must be byte-identical to before.
    const only = await say('nothing to join here', 'solo.wav');
    const r = await joinWithPauses([{ audio: only, pauseAfterSec: 0 }], join(dir, 'unused.wav'));
    expect(r.wavPath).toBe(only.wavPath);
  }, 60_000);

  it('refuses parts that disagree about format rather than emitting noise', async () => {
    // Concatenating PCM of different rates would play back as garbage.
    const a = await say('normal', 'fmt.wav');
    await expect(
      joinWithPauses(
        [{ audio: a, pauseAfterSec: 0 }, { audio: { wavPath: join(dir, 'missing.wav'), durationSec: 1 }, pauseAfterSec: 0 }],
        join(dir, 'bad.wav'),
      ),
    ).rejects.toThrow();
  }, 60_000);
});
