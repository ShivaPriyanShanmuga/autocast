import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);

/**
 * Registered under our own name so rendering never depends on what the
 * host machine happens to have installed. Spec section 6: identical glyph
 * rasterisation on all three platforms is the determinism keystone.
 *
 * It is also required for correctness: the generic "monospace" family
 * resolves to a PROPORTIONAL face on Windows (M=10.00 but i=3.56), which
 * would shear every column out of alignment.
 */
export const FONT_FAMILY = 'CastscriptMono';

let registered = false;

export function ensureFontRegistered(): void {
  if (registered) return;
  // Register the bold face too, so `bold` in a demo is the real 700 weight
  // rather than a synthesised smear of the regular one.
  for (const weight of ['400', '700']) {
    const path = require.resolve(
      `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`,
    );
    GlobalFonts.registerFromPath(path, FONT_FAMILY);
  }
  registered = true;
}

export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
  /** Y offset from the top of a cell to the text baseline. */
  baselineOffset: number;
  fontSpec: string;
}

/** Terminal line height as a multiple of the font size. */
const DEFAULT_LINE_HEIGHT = 1.35;

export function measureCell(
  fontSizePx: number,
  lineHeightRatio: number = DEFAULT_LINE_HEIGHT,
): CellMetrics {
  ensureFontRegistered();
  const fontSpec = `${fontSizePx}px "${FONT_FAMILY}"`;
  const ctx = createCanvas(8, 8).getContext('2d');
  ctx.font = fontSpec;
  const cellWidth = ctx.measureText('M').width;
  const cellHeight = Math.round(fontSizePx * lineHeightRatio);
  return {
    cellWidth,
    cellHeight,
    baselineOffset: Math.round((cellHeight + fontSizePx * 0.72) / 2),
    fontSpec,
  };
}
