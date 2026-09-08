import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CompositionPlan } from '../render/composition.js';
import type { SynthesisResult } from './backend.js';

export interface Clip {
  startSec: number;
  wavPath: string;
  durationSec: number;
}

const SAMPLE_RATE = 24_000;

/**
 * Where each piece of speech sits on the output timeline.
 *
 * Anchored to the same windows the `.vtt` cues come from, so audio and
 * captions cannot drift apart — there is one timeline, not two.
 */
export function planClips(
  plan: CompositionPlan,
  synthesized: Record<string, SynthesisResult>,
): Clip[] {
  const clips: Clip[] = [];
  for (const w of plan.windows) {
    if (!w.narration?.text.trim()) continue;
    const audio = synthesized[w.id];
    if (!audio) continue;
    clips.push({ startSec: w.outStartSec, wavPath: audio.wavPath, durationSec: audio.durationSec });
  }
  return clips;
}

/**
 * Mix the clips into one track as long as the video.
 *
 * A whole track in one file rather than streamed: section 13 forbids
 * buffering the whole VIDEO, and a minute of mono PCM is a couple of
 * megabytes. Doing it in one ffmpeg pass also means the offsets are
 * exact rather than accumulated.
 */
export async function buildTrack(
  clips: readonly Clip[],
  totalSec: number,
  outPath: string,
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const duration = Math.max(0.05, totalSec);

  // A silent bed of exactly the video's length, so the track can never be
  // shorter than the picture and `-shortest` can never truncate it.
  const args = [
    '-y',
    '-f', 'lavfi',
    '-t', duration.toFixed(3),
    '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
  ];
  for (const clip of clips) args.push('-i', clip.wavPath);

  if (clips.length === 0) {
    args.push('-c:a', 'pcm_s16le', outPath);
  } else {
    const parts = clips.map(
      (clip, i) =>
        `[${i + 1}:a]aresample=${SAMPLE_RATE},` +
        `adelay=${Math.round(clip.startSec * 1000)}:all=1[d${i}]`,
    );
    const inputs = clips.map((_, i) => `[d${i}]`).join('');
    // normalize=0 is load-bearing. amix divides by the number of inputs
    // by default, so a four-scene demo played at a fifth of the clip's
    // real level AND grew louder through the video as earlier inputs hit
    // EOF and stopped counting. Narration clips never overlap — they are
    // consecutive scenes — so summing them cannot clip.
    parts.push(
      `[0:a]${inputs}amix=inputs=${clips.length + 1}:duration=first:` +
        `dropout_transition=0:normalize=0,` +
        `atrim=0:${duration.toFixed(3)}[out]`,
    );
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[out]',
      '-c:a', 'pcm_s16le',
      outPath,
    );
  }

  await run(args);
}

function run(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    p.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    p.on('error', (e) =>
      reject(new Error(`could not run ffmpeg: ${e.message}. Run "autodemo doctor".`)),
    );
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code} building the audio track:\n${stderr.slice(-800)}`)),
    );
  });
}
