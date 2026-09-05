import { compilePattern } from '../schema/pattern.js';
import type { ScreenState } from './screen.js';

export interface CellRect {
  /** Column of the first matching cell. */
  col: number;
  row: number;
  /** Width in cells. */
  width: number;
  height: number;
}

/**
 * Locate a pattern in the terminal's character grid.
 *
 * This is the terminal's answer to a CSS selector. We own the grid, so a
 * match gives exact cell coordinates — no OCR, no guessing — and the
 * compositor can frame it precisely.
 *
 * The LAST match wins: a demo that zooms to show "the line that just
 * appeared" means the most recent one, and earlier output often repeats
 * the same text.
 */
export function findInScreen(screen: ScreenState, pattern: string): CellRect | null {
  const re = compilePattern(pattern);
  if (re === null) return null;

  let found: CellRect | null = null;

  for (let row = 0; row < screen.rows; row++) {
    const cells = screen.cells[row];
    if (!cells) continue;
    const text = cells.map((c) => c.char).join('');
    // Fresh lastIndex each row: a global regex would carry state across
    // rows and silently skip matches.
    const match = new RegExp(re.source, re.flags.replace('g', '')).exec(text);
    if (match) {
      found = { col: match.index, row, width: Math.max(1, match[0].length), height: 1 };
    }
  }

  return found;
}
