import type { CompositionPlan } from './composition.js';

export interface Cue {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * The caption sidecar.
 *
 * Written next to the mp4 for accessibility, but it earns its place as
 * the TEST SURFACE: the burned-in caption and this file come from the
 * same cues, so asserting the text and timings here verifies the drawn
 * ones without decoding a frame — which is what keeps caption
 * verification inside the no-frames-in-context rule (spec section 3).
 */
export function cuesFromPlan(plan: CompositionPlan): Cue[] {
  const cues: Cue[] = [];
  for (const w of plan.windows) {
    const text = w.narration?.text.trim();
    if (!text) continue;
    // The cue spans the whole window, head and tail included: both are
    // time the scene is on screen, and both are uncompressible, so a
    // caption can never be cut off by a scene ending early.
    cues.push({ startSec: w.outStartSec, endSec: w.outEndSec, text });
  }
  return cues;
}

export function formatTimestamp(sec: number): string {
  const t = Math.max(0, sec);
  const ms = Math.round(t * 1000);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(Math.floor(ms / 3_600_000))}:` +
    `${pad(Math.floor(ms / 60_000) % 60)}:` +
    `${pad(Math.floor(ms / 1000) % 60)}.` +
    `${pad(ms % 1000, 3)}`
  );
}

export function buildVtt(cues: readonly Cue[]): string {
  const lines = ['WEBVTT', ''];
  for (const cue of cues) {
    lines.push(`${formatTimestamp(cue.startSec)} --> ${formatTimestamp(cue.endSec)}`);
    // A blank line terminates a cue in WebVTT, so narration containing
    // one would silently split into a cue plus a stray fragment.
    lines.push(cue.text.replace(/\s*\n\s*/g, ' ').trim());
    lines.push('');
  }
  return lines.join('\n');
}
