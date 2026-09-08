import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { KokoroVoice, modelCacheDir, MODEL_ID } from './kokoro.js';
import { VoiceUnavailableError } from './backend.js';

const require = createRequire(import.meta.url);
const installed = (): boolean => {
  try {
    require.resolve('kokoro-js');
    return true;
  } catch {
    return false;
  }
};

describe('modelCacheDir', () => {
  it('leaves the full model path well under the Windows MAX_PATH', () => {
    // The bug this exists for: transformers.js caches under
    // node_modules/@huggingface/transformers/.cache, which measured 265
    // characters in a normal project. Past 260, onnxruntime reports that
    // a valid 92MB file does not exist.
    const deepest = `${modelCacheDir()}/${MODEL_ID}/onnx/model_quantized.onnx`;
    expect(deepest.length).toBeLessThan(200);
  });

  it('is absolute, so it does not follow the working directory', () => {
    expect(isAbsolute(modelCacheDir())).toBe(true);
  });
});

describe('KokoroVoice', () => {
  it('names itself for the cache key', () => {
    expect(new KokoroVoice().name).toBe('kokoro');
  });

  it.runIf(!installed())(
    'explains how to install itself rather than throwing a resolution error',
    async () => {
      const v = new KokoroVoice();
      await expect(
        v.synthesize({ text: 'hello', voice: 'af_heart', rate: 1 }, 'out.wav'),
      ).rejects.toThrow(VoiceUnavailableError);
      await expect(
        v.synthesize({ text: 'hello', voice: 'af_heart', rate: 1 }, 'out.wav'),
      ).rejects.toThrow(/npm i.*kokoro-js/);
    },
  );

  it.runIf(installed())(
    'speaks, and reports a duration that matches the file',
    async () => {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { probeAudio } = await import('./probe.js');

      const dir = mkdtempSync(join(tmpdir(), 'autodemo-kokoro-'));
      const v = new KokoroVoice();
      const out = join(dir, 'k.wav');
      const r = await v.synthesize(
        { text: 'First we start the order API.', voice: 'af_heart', rate: 1 },
        out,
      );
      const probe = await probeAudio(out);
      expect(r.durationSec).toBeCloseTo(probe.durationSec, 1);
      expect(r.durationSec).toBeGreaterThan(1);
    },
    600_000,
  );
});
