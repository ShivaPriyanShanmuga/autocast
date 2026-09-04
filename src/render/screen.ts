import { paletteColor, rgbToHex, type Theme } from './theme.js';

export interface RenderedCell {
  char: string;
  /** 1 normally, 2 for a wide glyph, 0 for its continuation cell. */
  width: number;
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export interface ScreenState {
  cols: number;
  rows: number;
  cells: RenderedCell[][];
}

interface XtermCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgDefault(): number | boolean;
  isFgPalette(): number | boolean;
  isFgRGB(): number | boolean;
  isBgDefault(): number | boolean;
  isBgPalette(): number | boolean;
  isBgRGB(): number | boolean;
  isBold(): number | boolean;
  isDim(): number | boolean;
  isItalic(): number | boolean;
  isUnderline(): number | boolean;
  isInverse(): number | boolean;
}

export interface XtermLike {
  cols: number;
  rows: number;
  buffer: {
    active: {
      baseY: number;
      getLine(i: number): { getCell(x: number): XtermCell | undefined } | undefined;
    };
  };
}

/**
 * xterm's attribute predicates return packed integers (bold is
 * 134217728), not booleans. Everything downstream expects real booleans.
 */
const flag = (v: number | boolean): boolean => Boolean(v);

function resolveColor(
  isDefault: number | boolean,
  isPalette: number | boolean,
  value: number,
  theme: Theme,
  fallback: string,
): string {
  if (flag(isDefault)) return fallback;
  if (flag(isPalette)) return paletteColor(theme, value);
  return rgbToHex(value);
}

const EMPTY = (theme: Theme): RenderedCell => ({
  char: ' ',
  width: 1,
  fg: theme.foreground,
  bg: theme.background,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
});

export function snapshotScreen(term: XtermLike, theme: Theme): ScreenState {
  const { cols, rows } = term;
  const buf = term.buffer.active;
  const cells: RenderedCell[][] = [];

  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    const row: RenderedCell[] = [];

    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x);
      if (!cell) {
        row.push(EMPTY(theme));
        continue;
      }

      let fg = resolveColor(
        cell.isFgDefault(),
        cell.isFgPalette(),
        cell.getFgColor(),
        theme,
        theme.foreground,
      );
      let bg = resolveColor(
        cell.isBgDefault(),
        cell.isBgPalette(),
        cell.getBgColor(),
        theme,
        theme.background,
      );

      // Resolve inverse here so the renderer never has to know about it.
      if (flag(cell.isInverse())) [fg, bg] = [bg, fg];

      const chars = cell.getChars();
      row.push({
        char: chars === '' ? ' ' : chars,
        width: cell.getWidth(),
        fg,
        bg,
        bold: flag(cell.isBold()),
        dim: flag(cell.isDim()),
        italic: flag(cell.isItalic()),
        underline: flag(cell.isUnderline()),
      });
    }

    cells.push(row);
  }

  return { cols, rows, cells };
}
