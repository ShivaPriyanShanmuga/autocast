import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { speechDurationSec } from '../render/speech.js';
import type { SynthesisRequest, SynthesisResult, VoiceBackend } from './backend.js';

const SAMPLE_RATE = 24_000;

/**
 * A tone of exactly the length the word-count estimate predicts.
 *
 * Every timing test in the pipeline runs on this rather than on a real
 * engine: synthesis measured 3-5x realtime in the spike, so a suite that
 * spoke for real would take minutes and would need a 89MB model in CI.
 *
 * It writes a GENUINE wav, not a stub. The tests downstream mux it,
 * probe it and measure it, so a placeholder that ffmpeg could not read
 * would be testing nothing.
 *
 * A TONE rather than silence, and that is not cosmetic. The first
 * version emitted silence, which is indistinguishable from a clip that
 * never made it into the mix — so a filter graph that dropped every clip
 * after the second passed every test and shipped a voiceover that fell
 * silent halfway through. Audible output is what makes "is the sound
 * where it should be" a question RMS can answer.
 */
export class FakeVoice implements VoiceBackend {
  readonly name = 'fake';

  async synthesize(req: SynthesisRequest, outPath: string): Promise<SynthesisResult> {
    if (req.text.trim() === '') {
      throw new Error('cannot synthesize empty narration');
    }
    const rate = Number.isFinite(req.rate) && req.rate > 0 ? req.rate : 1;
    const durationSec = speechDurationSec(req.text) / rate;
    const samples = Math.max(1, Math.round(durationSec * SAMPLE_RATE));

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, toneWav(samples));
    return { wavPath: outPath, durationSec };
  }
}

/** A quiet 16-bit mono PCM sine, loud enough to measure. */
function toneWav(samples: number): Buffer {
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // format: PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  // 440Hz at a quarter scale: deterministic, and nowhere near clipping
  // once several clips are mixed together.
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.25;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}
