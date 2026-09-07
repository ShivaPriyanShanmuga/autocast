export interface SynthesisRequest {
  text: string;
  voice: string;
  /** Speaking rate multiplier; 1 is the voice's natural pace. */
  rate: number;
}

export interface SynthesisResult {
  wavPath: string;
  durationSec: number;
}

/**
 * A source of speech.
 *
 * Deliberately narrow: text in, a WAV on disk and its measured duration
 * out. The measured duration is the entire reason this interface exists
 * — phase 6a made `planComposition` take a narration DURATION rather
 * than a text, so a backend has nothing to say about timing beyond how
 * long its own audio turned out to be.
 */
export interface VoiceBackend {
  readonly name: string;
  synthesize(req: SynthesisRequest, outPath: string): Promise<SynthesisResult>;
}

/** Thrown when a demo asks for a backend that is not installed. */
export class VoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceUnavailableError';
  }
}
