export interface Finding {
  /** H001 error text, H002 blank frame, H003 flatline, H004 duration. */
  code: string;
  scene: string;
  detail: string;
}

/**
 * Error signatures, matched against REAL TEXT rather than pixels.
 *
 * The terminal's character grid and the browser's DOM text are already
 * exact, so spec section 8's "no OCR is required" is literal: there is
 * no image analysis anywhere in this file's text scanning, and no LLM.
 */
const TERMINAL_SIGNATURES: Array<[RegExp, string]> = [
  [/^\s*Error:/m, 'an Error was printed'],
  [/\bECONNREFUSED\b|\bENOENT\b|\bEADDRINUSE\b/, 'a system error code appeared'],
  [/command not found|is not recognized as an internal/i, 'a command was not found'],
  [/npm ERR!|yarn error|pnpm ERR/i, 'a package manager reported an error'],
  [/Traceback \(most recent call last\)/, 'a Python traceback appeared'],
  [/panic:|SIGSEGV|core dumped/i, 'a crash was reported'],
];

const BROWSER_SIGNATURES: Array<[RegExp, string]> = [
  [/Unhandled Runtime Error|Application error/i, 'a framework error overlay appeared'],
  [
    /\b5\d\d\b\s+(Internal Server Error|Bad Gateway|Service Unavailable)/i,
    'a server error page appeared',
  ],
  [/\b404\b\s+(Not Found|page not found)/i, 'a not-found page appeared'],
  [/This site can.t be reached|ERR_CONNECTION_REFUSED/i, 'the page failed to load'],
];

function scan(
  scene: string,
  text: string,
  signatures: ReadonlyArray<[RegExp, string]>,
): Finding[] {
  const out: Finding[] = [];
  for (const [pattern, why] of signatures) {
    const m = pattern.exec(text);
    if (m) out.push({ code: 'H001', scene, detail: `${why}: ${m[0].trim().slice(0, 120)}` });
  }
  return out;
}

export function scanTerminalText(scene: string, text: string): Finding[] {
  return scan(scene, text, TERMINAL_SIGNATURES);
}

export function scanBrowserText(scene: string, text: string): Finding[] {
  return scan(scene, text, BROWSER_SIGNATURES);
}

/** A whole flat frame means nothing rendered. */
export function detectBlankFrame(scene: string, rgba: Buffer): Finding | null {
  if (rgba.length < 16) return null;
  const first = rgba.readUInt32LE(0);
  const stride = 4 * 37; // already a multiple of 4, so reads stay aligned
  for (let i = stride; i + 4 <= rgba.length; i += stride) {
    if (rgba.readUInt32LE(i) !== first) return null;
  }
  return {
    code: 'H002',
    scene,
    detail: 'the frame is a single flat colour — nothing rendered',
  };
}

/** Identical frames throughout mean the scene never moved. */
export function detectFlatline(scene: string, frames: readonly Buffer[]): Finding | null {
  if (frames.length < 2) return null;
  const first = frames[0]!;
  for (const frame of frames.slice(1)) {
    if (frame.length !== first.length) return null;
    for (let i = 0; i < frame.length; i += 4 * 101) {
      if (frame[i] !== first[i]) return null;
    }
  }
  return {
    code: 'H003',
    scene,
    detail: `${frames.length} sampled frames are identical — the scene never changed`,
  };
}

/**
 * A scene wildly longer than its peers usually means something hung.
 *
 * Each scene is compared against the median of the OTHERS, not of all
 * scenes including itself. With a plain median, two scenes of 4s and 38s
 * produce a median of 38s and nothing is flagged — precisely the case
 * that matters, since aborting on the first failure often leaves only
 * two scenes to compare.
 */
/**
 * No scene shorter than this is ever called a hang, whatever the ratio.
 *
 * A hung scene is one waiting on something that will never happen, so it
 * runs to a timeout. Seconds are just work.
 */
export const MIN_ANOMALY_SEC = 10;

export function detectDurationAnomaly(
  durations: ReadonlyArray<{ id: string; sec: number }>,
): Finding[] {
  if (durations.length < 2) return [];

  const medianOf = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  };

  const out: Finding[] = [];
  for (const d of durations) {
    const others = durations.filter((o) => o.id !== d.id).map((o) => o.sec);
    const median = medianOf(others);
    if (median <= 0) continue;
    // BOTH conditions, not either. A hang is slow in absolute terms;
    // being slow relative to peers is not enough when the peers did no
    // work. A real cold-start demo had three assertion-only scenes
    // measuring 0s, which dragged the median to 0.4s and flagged the two
    // scenes that were doing their job.
    if (d.sec >= MIN_ANOMALY_SEC && d.sec > median * 5) {
      out.push({
        code: 'H004',
        scene: d.id,
        detail:
          `scene ran ${d.sec.toFixed(1)}s, over 5x the ${median.toFixed(1)}s median ` +
          'of the other scenes — something may have hung',
      });
    }
  }
  return out;
}

export interface NarrationOutput {
  /** Any scene has non-empty `narrate:` text. */
  hasNarration: boolean;
  captionsOn: boolean;
  voiceEnabled: boolean;
}

/**
 * Narration that will not be heard, and was not asked to be silent.
 *
 * Voice is opt-in for a good reason — the engine is a ~300MB optional
 * dependency and `render` must not reach for the network on a demo that
 * never asked to speak. The bug was never the default. It was that a
 * render would reserve seconds of screen time per scene to fit narration
 * (section 7.1.1's floor), ship no audio, and say nothing about either,
 * so the same surprise kept recurring.
 */
export function detectSilentNarration(o: NarrationOutput): Finding[] {
  if (!o.hasNarration || o.voiceEnabled) return [];

  if (!o.captionsOn) {
    return [
      {
        code: 'H006',
        scene: '*',
        detail:
          'scenes have narrate: text but neither captions nor voice is on, so it is ' +
          'not presented at all — remove style.captions: false, or set ' +
          'voice: { enabled: true }',
      },
    ];
  }

  return [
    {
      code: 'H006',
      scene: '*',
      detail:
        'narration is rendered as captions only — this video has no audio track. ' +
        'For a voiceover: npm i -D kokoro-js, then voice: { enabled: true }',
    },
  ];
}
