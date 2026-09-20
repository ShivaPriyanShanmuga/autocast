import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SynthesisResult } from './backend.js';

export interface PausedClip {
  audio: SynthesisResult;
  pauseAfterSec: number;
}

interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

/** Walk the RIFF chunks rather than assuming a 44-byte header. */
function readWav(buf: Buffer, path: string): Wav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${path} is not a wav file`);
  }
  let off = 12;
  let fmt: { sampleRate: number; channels: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path} has no fmt or data chunk`);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, data };
}

function wavHeader(bytes: number, w: Omit<Wav, 'data'>): Buffer {
  const h = Buffer.alloc(44);
  const blockAlign = (w.channels * w.bitsPerSample) / 8;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(w.channels, 22);
  h.writeUInt32LE(w.sampleRate, 24);
  h.writeUInt32LE(w.sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(w.bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(bytes, 40);
  return h;
}

/**
 * One wav from several, with real silence held between them.
 *
 * Done by splicing PCM rather than by shelling out: every part is
 * already the same format, the silence is a run of zero samples, and
 * doing it in process keeps the result deterministic and avoids another
 * ffmpeg round trip per narrated scene.
 *
 * The formats are CHECKED, not assumed. Concatenating PCM at two
 * different sample rates produces something that plays back as noise
 * rather than failing, which is the worst kind of bug to ship.
 */
export async function joinWithPauses(
  clips: readonly PausedClip[],
  outPath: string,
): Promise<SynthesisResult> {
  if (clips.length === 0) throw new Error('nothing to join');

  // Nothing to do: hand back the original so a demo without pause marks
  // is byte-identical to one rendered before this existed.
  if (clips.length === 1 && clips[0]!.pauseAfterSec <= 0) return clips[0]!.audio;

  const parts: Wav[] = [];
  for (const clip of clips) {
    parts.push(readWav(await readFile(clip.audio.wavPath), clip.audio.wavPath));
  }

  const first = parts[0]!;
  for (const [i, p] of parts.entries()) {
    if (
      p.sampleRate !== first.sampleRate ||
      p.channels !== first.channels ||
      p.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error(
        `narration part ${i} is ${p.sampleRate}Hz/${p.channels}ch/${p.bitsPerSample}bit but ` +
          `part 0 is ${first.sampleRate}Hz/${first.channels}ch/${first.bitsPerSample}bit — ` +
          'these cannot be spliced',
      );
    }
  }

  const bytesPerSec = first.sampleRate * first.channels * (first.bitsPerSample / 8);
  const chunks: Buffer[] = [];
  for (const [i, p] of parts.entries()) {
    chunks.push(p.data);
    const pause = clips[i]!.pauseAfterSec;
    if (pause > 0) chunks.push(Buffer.alloc(Math.round(pause * bytesPerSec)));
  }

  const body = Buffer.concat(chunks);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.concat([wavHeader(body.length, first), body]));

  return { wavPath: outPath, durationSec: body.length / bytesPerSec };
}
