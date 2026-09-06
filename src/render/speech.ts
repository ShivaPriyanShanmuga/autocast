/**
 * How long narration takes to deliver.
 *
 * The single source of a word rate in the codebase. Phase 6a estimates a
 * scene's narration duration from this; phase 6b will measure synthesised
 * audio instead and feed the result through the same planner input, so
 * nothing downstream has to know which it got (spec section 7.1.2).
 */

/**
 * 150 words per minute — a deliberate compromise, not a measurement.
 *
 * Comfortable caption reading is faster than comfortable speech. Using
 * the right number for each would mean the silent cut stops being a
 * preview of the narrated one, and a scene's pacing would shift the day
 * voice was switched on. One number, wrong by a little in both
 * directions, beats two numbers that disagree.
 */
export const DEFAULT_WPM = 150;

/**
 * Words in a piece of narration.
 *
 * Shares its rule with the linter's narration ceiling. If the two
 * disagreed about what a word is, an L007 warning would stop predicting
 * the hold the planner actually reserves.
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function speechDurationSec(text: string, wpm: number = DEFAULT_WPM): number {
  const words = countWords(text);
  if (words === 0) return 0;
  // A zero, negative or non-finite rate would yield Infinity, and a scene
  // of infinite length is a hang rather than a video.
  const rate = Number.isFinite(wpm) && wpm > 0 ? wpm : DEFAULT_WPM;
  return (words / rate) * 60;
}
