import { createRequire } from 'node:module';
import type { CastLog } from '../backends/terminal/cast.js';
import { snapshotScreen, type ScreenState, type XtermLike } from './screen.js';
import { DEFAULT_THEME, type Theme } from './theme.js';

const require = createRequire(import.meta.url);

export interface ReplayOptions {
  fps: number;
  theme?: Theme;
  /** Extra time to hold the final state, so the video does not cut dead. */
  tailMs?: number;
}

const DEFAULT_TAIL_MS = 800;

function durationSec(cast: CastLog): number {
  return cast.events.length === 0 ? 0 : (cast.events[cast.events.length - 1]![0] ?? 0);
}

export function frameCount(cast: CastLog, fps: number, tailMs = DEFAULT_TAIL_MS): number {
  const total = durationSec(cast) + tailMs / 1000;
  return Math.max(1, Math.ceil(total * fps));
}

/**
 * Replay the asciicast into a fresh terminal, yielding one screen state
 * per frame boundary. This is the "render offline from the log" half of
 * spec section 4.2: no process is re-run, and the frame rate, size and
 * theme are all free parameters.
 */
export async function* replayCast(
  cast: CastLog,
  opts: ReplayOptions,
): AsyncGenerator<ScreenState> {
  const theme = opts.theme ?? DEFAULT_THEME;
  const tailMs = opts.tailMs ?? DEFAULT_TAIL_MS;

  const { Terminal } = require('@xterm/headless') as {
    Terminal: new (o: Record<string, unknown>) => XtermLike & {
      write(data: string, cb?: () => void): void;
    };
  };

  const term = new Terminal({
    cols: cast.width,
    rows: cast.height,
    allowProposedApi: true,
    scrollback: 0, // the visible screen is the frame; history is not drawn
  });

  const write = (data: string) => new Promise<void>((r) => term.write(data, r));

  const total = frameCount(cast, opts.fps, tailMs);
  let next = 0; // index of the next unapplied event

  for (let frame = 0; frame < total; frame++) {
    const t = (frame + 1) / opts.fps;
    while (next < cast.events.length && cast.events[next]![0] <= t) {
      await write(cast.events[next]![2]);
      next++;
    }
    yield snapshotScreen(term, theme);
  }
}
