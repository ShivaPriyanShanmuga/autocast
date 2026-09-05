import { createRequire } from 'node:module';
import type { CastLog } from '../backends/terminal/cast.js';
import { snapshotScreen, type ScreenState, type XtermLike } from './screen.js';
import type { Theme } from './theme.js';

const require = createRequire(import.meta.url);

/**
 * A seekable view of an asciicast.
 *
 * Composition interleaves sessions — terminal, then browser, then the
 * terminal again — so the terminal must be advanced to arbitrary points
 * on the output timeline while keeping everything that came before.
 *
 * Seeking is forward-only by design: a terminal's screen is the sum of
 * every byte before it, so rewinding would mean replaying from scratch.
 * A backwards request is a caller bug, and saying so beats silently
 * rendering the wrong screen.
 */
export class CastPlayer {
  private readonly term: XtermLike & { write(data: string, cb?: () => void): void };
  private next = 0;
  private at = 0;

  constructor(
    private readonly cast: CastLog,
    private readonly theme: Theme,
  ) {
    const { Terminal } = require('@xterm/headless') as {
      Terminal: new (o: Record<string, unknown>) => XtermLike & {
        write(data: string, cb?: () => void): void;
      };
    };
    this.term = new Terminal({
      cols: cast.width,
      rows: cast.height,
      allowProposedApi: true,
      scrollback: 0, // the visible screen is the frame; history is not drawn
    });
  }

  get position(): number {
    return this.at;
  }

  async advanceTo(tSec: number): Promise<void> {
    if (tSec < this.at - 1e-9) {
      throw new Error(
        `CastPlayer only seeks forward: asked for ${tSec.toFixed(3)}s ` +
          `while at ${this.at.toFixed(3)}s`,
      );
    }
    while (this.next < this.cast.events.length && this.cast.events[this.next]![0] <= tSec) {
      const data = this.cast.events[this.next]![2];
      await new Promise<void>((resolve) => this.term.write(data, resolve));
      this.next++;
    }
    this.at = tSec;
  }

  screen(): ScreenState {
    return snapshotScreen(this.term, this.theme);
  }
}
