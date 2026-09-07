import type { Finding } from './heuristics.js';

/**
 * How far audio may be sped up before it is audible.
 *
 * Spec 7.1 lever 3 caps time-stretching at 10%, pitch-preserved.
 */
export const STRETCH_LIMIT = 0.1;

/**
 * Below this, a scene is doing no work of its own.
 *
 * Not zero. The flagship's assertions-only scenes measure 0.001s rather
 * than 0.000s — an assertion still takes a moment to evaluate — so an
 * exact-zero exemption let them through and reported that narration was
 * holding open a scene that had nothing in it to hold.
 */
export const ACTION_FLOOR_SEC = 0.25;

export interface SceneSync {
  id: string;
  narrationSec: number;
  /** The scene's own measured duration, before any floor was applied. */
  actionSec: number;
}

/**
 * How much to speed narration up so it fits the action.
 *
 * DEVIATION from spec 7.1's stated lever order, recorded in 7.1.3.
 * 7.1 runs "extend holds" before "time-stretch audio", but since 7.1.1
 * the floor has already extended the scene by the time the stretch would
 * run, so the lever is unreachable. Reversing them is also simply
 * better: a pitch-preserved 10% stretch is inaudible, while holding a
 * scene 10% longer is visible.
 */
export function stretchFor(narrationSec: number, actionSec: number): number {
  // Nothing to fit to: an assertions-only scene is defined by its
  // narration, so there is no action for the voice to outrun.
  if (actionSec < ACTION_FLOOR_SEC || narrationSec <= actionSec) return 1;
  return Math.min(narrationSec / actionSec, 1 + STRETCH_LIMIT);
}

/**
 * Scenes whose pacing is being set by words rather than by what happens.
 *
 * DEVIATION from spec 7.1 lever 4, recorded in 7.1.3. As written, that
 * lever fails when narration does not fit — but since 7.1.1 it always
 * fits, because `bodySec` takes the max. The failure worth keeping is
 * the one it was reaching for: a demo whose video is being held open to
 * finish a sentence.
 */
export function checkSync(scenes: readonly SceneSync[], mode: 'hold' | 'strict'): Finding[] {
  if (mode !== 'strict') return [];

  const findings: Finding[] = [];
  for (const scene of scenes) {
    if (scene.actionSec < ACTION_FLOOR_SEC) continue;
    // Whatever the stretch could not absorb is what actually slowed the
    // video down.
    const afterStretch = scene.narrationSec / stretchFor(scene.narrationSec, scene.actionSec);
    if (afterStretch <= scene.actionSec + 1e-9) continue;
    findings.push({
      code: 'H005',
      scene: scene.id,
      detail:
        `narration needs ${afterStretch.toFixed(1)}s but the scene only does ` +
        `${scene.actionSec.toFixed(1)}s of work, so the video is being held open to ` +
        'finish the sentence — shorten the narration, or set voice.sync: hold to accept it',
    });
  }
  return findings;
}
