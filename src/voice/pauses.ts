/**
 * Narration split into parts, with real silence held between them.
 *
 * Punctuation cannot do this. Measured against Kokoro: a comma, a full
 * stop, an ellipsis, a dash and no punctuation at all produce the same
 * ~0.30s break, because the model imposes its own prosody and ignores
 * the cue. So a pause the author actually wants has to be silence
 * between separately synthesized clips — which costs nothing to build,
 * since the audio timeline already places clips at arbitrary offsets.
 *
 * Where a pause BELONGS is a question about meaning, and the renderer
 * has no model and must stay zero-LLM so a re-render is free. The agent
 * writing the script does know, and its answer is committed (spec
 * 7.1.2). Same shape as `speak:` for heteronyms.
 */
export const PAUSE_MARK = '||';

/** A beat, when no length is given. Long enough to land, short enough not to stall. */
export const DEFAULT_PAUSE_SEC = 0.45;

/** Beyond this it reads as the video having frozen. */
export const MAX_PAUSE_SEC = 3;

export interface NarrationPart {
  text: string;
  /** Silence held after this part, in seconds. Zero for the last one. */
  pauseAfterSec: number;
}

// The sign is matched so a negative duration is CONSUMED rather than
// left behind: without it "||-5 go" spoke the characters "-5" aloud,
// which is worse than getting the pause length wrong.
const MARK = /\|\|\s*(-?\d+(?:\.\d+)?)?/;

export function splitPauses(narration: string): NarrationPart[] {
  const parts: NarrationPart[] = [];
  let rest = narration;

  for (;;) {
    const m = MARK.exec(rest);
    if (!m) break;
    const text = rest.slice(0, m.index).trim();
    const requested = m[1] === undefined ? DEFAULT_PAUSE_SEC : Number(m[1]);
    const pauseAfterSec = Math.max(0, Math.min(MAX_PAUSE_SEC, requested));

    // An empty part means a doubled or leading mark — an authoring slip.
    // Synthesizing "" is rejected by the engine outright, so fold the
    // pause onto whatever came before instead of emitting nothing.
    if (text === '') {
      if (parts.length > 0) {
        const last = parts[parts.length - 1]!;
        last.pauseAfterSec = Math.min(MAX_PAUSE_SEC, last.pauseAfterSec + pauseAfterSec);
      }
    } else {
      parts.push({ text, pauseAfterSec });
    }
    rest = rest.slice(m.index + m[0].length);
  }

  const tail = rest.trim();
  if (tail !== '') parts.push({ text: tail, pauseAfterSec: 0 });
  else if (parts.length > 0) parts[parts.length - 1]!.pauseAfterSec = 0;

  return parts;
}

/** Total silence a narration will add, for the timing floor to reserve. */
export function pauseTotalSec(parts: readonly NarrationPart[]): number {
  return parts.reduce((n, p) => n + p.pauseAfterSec, 0);
}
