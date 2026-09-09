import type { DemoScript } from '../schema/demo.js';
import { VoiceUnavailableError, type VoiceBackend } from './backend.js';
import { FakeVoice } from './fake.js';
import { KokoroVoice } from './kokoro.js';

export const DEFAULT_VOICE = 'af_heart';

export interface VoiceConfig {
  enabled: boolean;
  backend: 'kokoro' | 'fake';
  voice: string;
  rate: number;
  sync: 'hold' | 'strict';
}

/**
 * Voice is OFF unless asked for.
 *
 * Captions can default on because they cost nothing; the default voice
 * engine is an optional dependency pulling roughly 300MB, so turning it
 * on by default would make `castscript render` reach for the network on a
 * demo that never asked to speak (spec 7.1.3).
 */
export function resolveVoice(script: DemoScript): VoiceConfig {
  const v = script.voice;
  return {
    enabled: v?.enabled ?? false,
    backend: v?.backend ?? 'kokoro',
    voice: v?.voice ?? DEFAULT_VOICE,
    rate: v?.rate ?? 1,
    sync: v?.sync ?? 'hold',
  };
}

export function voiceBackendFor(config: VoiceConfig): VoiceBackend {
  switch (config.backend) {
    case 'fake':
      return new FakeVoice();
    case 'kokoro':
      return new KokoroVoice();
    default: {
      const never: never = config.backend;
      throw new VoiceUnavailableError(`unknown voice backend "${String(never)}"`);
    }
  }
}

export { VoiceUnavailableError } from './backend.js';
export type { VoiceBackend, SynthesisRequest, SynthesisResult } from './backend.js';
