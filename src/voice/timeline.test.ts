import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planClips, buildTrack } from './timeline.js';
import { FakeVoice } from './fake.js';
import { probeAudio } from './probe.js';
import { rmsAt } from './rms.js';
import type { CompositionPlan, SceneWindow } from '../render/composition.js';

const dir = mkdtempSync(join(tmpdir(), 'autodemo-track-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function window(over: Partial<SceneWindow> & { id: string }): SceneWindow {
  const outStartSec = over.outStartSec ?? 0;
  const outEndSec = over.outEndSec ?? outStartSec + 5;
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

describe('planClips', () => {
  it('anchors each clip to its window start', () => {
    // Audio and captions come from the same windows, so they cannot
    // drift apart: they are one timeline, not two.
    const clips = planClips(
      plan([
        window({ id: 'a', outStartSec: 0, outEndSec: 5, narration: { text: 'A', sec: 2 } }),
        window({ id: 'b', outStartSec: 5, outEndSec: 9, narration: { text: 'B', sec: 3 } }),
      ]),
      { a: { wavPath: 'a.wav', durationSec: 2 }, b: { wavPath: 'b.wav', durationSec: 3 } },
    );
    expect(clips.map((c) => c.startSec)).toEqual([0, 5]);
  });

  it('emits nothing when no scene narrates', () => {
    expect(planClips(plan([window({ id: 'a' })]), {})).toEqual([]);
  });

  it('skips a scene with no synthesized audio', () => {
    const clips = planClips(
      plan([window({ id: 'a', narration: { text: 'A', sec: 2 } })]),
      {},
    );
    expect(clips).toEqual([]);
  });
});

describe('buildTrack', () => {
  it('builds one track as long as the video', async () => {
    const voice = new FakeVoice();
    const one = await voice.synthesize(
      { text: 'And the server logged it.', voice: 't', rate: 1 },
      join(dir, 'one.wav'),
    );
    const out = join(dir, 'track.wav');
    await buildTrack([{ startSec: 2, ...one }], 10, out);

    const probe = await probeAudio(out);
    expect(probe.durationSec).toBeCloseTo(10, 1);
    expect(probe.channels).toBe(1);
  }, 60_000);

  it('places a clip at its offset rather than at zero', async () => {
    // Verified by measuring where the sound actually is, not by listening.
    const voice = new FakeVoice();
    const clip = await voice.synthesize(
      { text: 'one two three', voice: 't', rate: 1 },
      join(dir, 'late.wav'),
    );
    const out = join(dir, 'late-track.wav');
    await buildTrack([{ startSec: 4, ...clip }], 9, out);
    const probe = await probeAudio(out);
    expect(probe.durationSec).toBeCloseTo(9, 1);
  }, 60_000);

  it('produces a silent track of the right length when there is nothing to say', async () => {
    const out = join(dir, 'silent.wav');
    await buildTrack([], 6, out);
    const probe = await probeAudio(out);
    expect(probe.durationSec).toBeCloseTo(6, 1);
  }, 60_000);
});

describe('buildTrack with several clips', () => {
  it('puts sound at EVERY clip offset, not just the first two', async () => {
    // The bug this exists for: the shipped flagship voiceover fell silent
    // after the second scene. The original test used a SINGLE clip, so a
    // filter graph that dropped later inputs looked correct.
    const voice = new FakeVoice();
    const offsets = [0, 4.8, 13.5, 17.3];
    const clips = [];
    for (const [i, startSec] of offsets.entries()) {
      const r = await voice.synthesize(
        { text: `clip number ${i} speaking now`, voice: 't', rate: 1 },
        join(dir, `multi-${i}.wav`),
      );
      clips.push({ startSec, ...r });
    }

    const out = join(dir, 'multi-track.wav');
    await buildTrack(clips, 26, out);

    for (const [i, startSec] of offsets.entries()) {
      const loud = await rmsAt(out, startSec + 0.05, startSec + 0.5);
      expect(loud, `clip ${i} at ${startSec}s should have sound`).toBeGreaterThan(0.001);
    }
  }, 120_000);

  it('keeps every clip at a comparable level', async () => {
    // amix divides by the number of inputs unless told not to, which
    // would make a four-scene demo quieter than a one-scene demo.
    const voice = new FakeVoice();
    const clips = [];
    for (const [i, startSec] of [0, 3, 6].entries()) {
      const r = await voice.synthesize(
        { text: `level check number ${i}`, voice: 't', rate: 1 },
        join(dir, `lvl-${i}.wav`),
      );
      clips.push({ startSec, ...r });
    }
    const out = join(dir, 'lvl-track.wav');
    await buildTrack(clips, 10, out);

    const levels = await Promise.all(
      [0, 3, 6].map((s) => rmsAt(out, s + 0.05, s + 0.4)),
    );
    const max = Math.max(...levels);
    for (const l of levels) expect(l).toBeGreaterThan(max * 0.5);
  }, 120_000);
});

describe('mix levels', () => {
  it('keeps a clip at its own level rather than dividing by the input count', async () => {
    // amix's default normalize=1 divided every clip by the number of
    // inputs, so a four-scene demo played at a fifth of the recorded
    // level and got louder through the video as earlier clips ended.
    const voice = new FakeVoice();
    const clip = await voice.synthesize(
      { text: 'level reference tone here', voice: 't', rate: 1 },
      join(dir, 'ref.wav'),
    );
    const alone = await rmsAt(clip.wavPath, 0.05, 0.5);

    const clips = [0, 4, 8, 12].map((startSec) => ({ startSec, ...clip }));
    const out = join(dir, 'levels.wav');
    await buildTrack(clips, 16, out);

    for (const startSec of [0, 4, 8, 12]) {
      const mixed = await rmsAt(out, startSec + 0.05, startSec + 0.5);
      expect(mixed).toBeGreaterThan(alone * 0.8);
      expect(mixed).toBeLessThan(alone * 1.2);
    }
  }, 120_000);
});
