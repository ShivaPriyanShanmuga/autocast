export interface Theme {
  background: string;
  foreground: string;
  /** The 16 standard ANSI colours, in order. */
  palette: string[];
}

export const DEFAULT_THEME: Theme = {
  background: '#101014',
  foreground: '#d8d8e0',
  palette: [
    '#1c1c22',
    '#e05561',
    '#8ccf7e',
    '#e2b86b',
    '#4fa6ed',
    '#bf68d9',
    '#48b0bd',
    '#a1a1aa',
    '#3b3b45',
    '#ff6b78',
    '#a5e58f',
    '#f5cc7f',
    '#68b8ff',
    '#d885f0',
    '#5ac8d6',
    '#e4e4e8',
  ],
};

export function rgbToHex(packed: number): string {
  return `#${(packed & 0xffffff).toString(16).padStart(6, '0')}`;
}

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

/**
 * Resolve an xterm-256 palette index.
 *   0-15    the named ANSI colours
 *   16-231  a 6x6x6 RGB cube
 *   232-255 a 24-step greyscale ramp
 */
export function paletteColor(theme: Theme, index: number): string {
  const i = Math.max(0, Math.min(255, Math.round(index)));

  if (i < 16) return theme.palette[i] ?? theme.foreground;

  if (i < 232) {
    const n = i - 16;
    const r = CUBE_STEPS[Math.floor(n / 36) % 6]!;
    const g = CUBE_STEPS[Math.floor(n / 6) % 6]!;
    const b = CUBE_STEPS[n % 6]!;
    return rgbToHex((r << 16) | (g << 8) | b);
  }

  const level = 8 + (i - 232) * 10;
  return rgbToHex((level << 16) | (level << 8) | level);
}
