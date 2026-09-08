import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  VoiceUnavailableError,
  type SynthesisRequest,
  type SynthesisResult,
  type VoiceBackend,
} from './backend.js';

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** Quantised: 92MB rather than 330MB, at no audible cost for narration. */
const DTYPE = 'q8';

/**
 * Where the model lives.
 *
 * Short, and deliberately NOT the library default. transformers.js caches
 * under `node_modules/@huggingface/transformers/.cache`; in a normal
 * project that path measured 265 characters, past Windows' 260-character
 * MAX_PATH, and onnxruntime then reported that a valid 92MB file did not
 * exist. Verified by spike, 2026-09-06 (spec section 7.1.3).
 */
export function modelCacheDir(): string {
  return process.env.AUTODEMO_MODEL_DIR ?? join(homedir(), '.autodemo', 'models');
}

const INSTALL_HINT =
  'Voice needs the Kokoro engine, which autodemo does not install by default ' +
  'because it pulls roughly 300MB of onnxruntime.\n' +
  '  npm i -D kokoro-js\n' +
  'The voice model (~92MB) downloads on first use into ' +
  `${modelCacheDir()}.`;

/**
 * Import something that may not be installed.
 *
 * The specifier is a variable so the compiler does not try to resolve it:
 * these are optional dependencies, and a build must not require them to
 * be present.
 */
async function importOptional(id: string): Promise<unknown> {
  return import(/* @vite-ignore */ id);
}

interface KokoroModule {
  KokoroTTS: {
    from_pretrained(
      id: string,
      opts: { dtype: string; device: string },
    ): Promise<{
      generate(
        text: string,
        opts: { voice: string; speed?: number },
      ): Promise<{ audio: Float32Array; sampling_rate: number }>;
    }>;
  };
}

export class KokoroVoice implements VoiceBackend {
  readonly name = 'kokoro';
  private engine: Awaited<
    ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>
  > | null = null;

  /**
   * Imported dynamically so that not having the optional dependency is a
   * named, actionable error rather than a module-resolution crash before
   * anything has had a chance to explain itself.
   */
  private async load(): Promise<NonNullable<typeof this.engine>> {
    if (this.engine) return this.engine;
    let mod: KokoroModule;
    let transformers: { env: { cacheDir: string } };
    try {
      mod = (await importOptional('kokoro-js')) as KokoroModule;
      transformers = (await importOptional(
        '@huggingface/transformers',
      )) as typeof transformers;
    } catch {
      throw new VoiceUnavailableError(INSTALL_HINT);
    }

    // MUST be set before the model loads; see modelCacheDir.
    transformers.env.cacheDir = modelCacheDir();
    await mkdir(modelCacheDir(), { recursive: true });

    this.engine = await mod.KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: 'cpu',
    });
    return this.engine;
  }

  async synthesize(req: SynthesisRequest, outPath: string): Promise<SynthesisResult> {
    if (req.text.trim() === '') throw new Error('cannot synthesize empty narration');
    const engine = await this.load();
    const audio = await engine.generate(req.text, {
      voice: req.voice,
      ...(req.rate === 1 ? {} : { speed: req.rate }),
    });

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, wavFromFloat32(audio.audio, audio.sampling_rate));
    return {
      wavPath: outPath,
      durationSec: audio.audio.length / audio.sampling_rate,
    };
  }
}

/** 16-bit PCM: half the bytes of float32, and universally readable. */
function wavFromFloat32(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}
