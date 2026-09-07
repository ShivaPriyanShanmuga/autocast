import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SynthesisRequest, SynthesisResult, VoiceBackend } from './backend.js';
import { probeAudio } from './probe.js';

/**
 * Content address for a piece of speech.
 *
 * The backend name and voice are part of the key: the same words spoken
 * by a different engine, or in a different voice, are different audio
 * and must not collide.
 */
export function cacheKey(backend: string, req: SynthesisRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([backend, req.voice, req.rate, req.text]))
    .digest('hex')
    .slice(0, 32);
}

export function cachedPath(dir: string, key: string): string {
  return join(dir, `${key}.wav`);
}

/**
 * Synthesize, or reuse what we synthesized before.
 *
 * Caching is a requirement rather than an optimisation here: the spike
 * measured Kokoro at 3-5x realtime, so an uncached re-render of a
 * one-minute demo would spend minutes speaking words it already knows.
 */
export async function synthesizeCached(
  backend: VoiceBackend,
  req: SynthesisRequest,
  dir: string,
): Promise<SynthesisResult> {
  await mkdir(dir, { recursive: true });
  const path = cachedPath(dir, cacheKey(backend.name, req));

  try {
    // A render interrupted mid-write leaves a truncated file behind.
    // Trusting it would produce a silent demo with no error anywhere, so
    // the entry has to be readable AS AUDIO, not merely present.
    const info = await stat(path);
    if (info.size > 44) {
      const probe = await probeAudio(path);
      if (probe.durationSec > 0) return { wavPath: path, durationSec: probe.durationSec };
    }
  } catch {
    // Missing, unreadable or not audio — synthesize it again.
  }

  return backend.synthesize(req, path);
}
