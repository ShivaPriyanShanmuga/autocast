import { describe, it, expect } from 'vitest';
import { findInScreen } from './find-in-screen.js';
import type { ScreenState, RenderedCell } from './screen.js';

const cell = (char: string): RenderedCell => ({
  char,
  width: 1,
  fg: '#fff',
  bg: '#000',
  bold: false,
  dim: false,
  italic: false,
  underline: false,
});

function screen(lines: string[], cols = 40): ScreenState {
  return {
    cols,
    rows: lines.length,
    cells: lines.map((line) =>
      Array.from({ length: cols }, (_, x) => cell(line[x] ?? ' ')),
    ),
  };
}

describe('findInScreen', () => {
  it('finds a literal string and reports its cell rect', () => {
    const r = findInScreen(screen(['hello', 'POST /api/orders 201']), 'POST');
    expect(r).toEqual({ col: 0, row: 1, width: 4, height: 1 });
  });

  it('finds a regex', () => {
    const r = findInScreen(screen(['listening on :34700']), '/:\\d+/');
    expect(r?.row).toBe(0);
    expect(r?.width).toBe(6);
  });

  it('reports the column offset within the line', () => {
    const r = findInScreen(screen(['  indented match']), 'match');
    expect(r?.col).toBe(11);
  });

  it('takes the LAST match, which is the line that just appeared', () => {
    const r = findInScreen(screen(['POST /a 201', 'other', 'POST /b 201']), 'POST');
    expect(r?.row).toBe(2);
  });

  it('returns null when nothing matches', () => {
    expect(findInScreen(screen(['nothing here']), 'absent')).toBeNull();
  });

  it('returns null for an uncompilable pattern', () => {
    expect(findInScreen(screen(['x']), '/oops(/')).toBeNull();
  });

  it('handles an empty screen', () => {
    expect(findInScreen(screen([]), 'x')).toBeNull();
  });

  it('does not skip matches because of a global flag', () => {
    // A shared global regex carries lastIndex across rows and silently
    // misses matches on later lines.
    const r = findInScreen(screen(['aaa', 'aaa', 'aaa']), '/a+/g');
    expect(r?.row).toBe(2);
  });
});
