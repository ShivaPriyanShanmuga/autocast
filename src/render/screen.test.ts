import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { DEFAULT_THEME } from './theme.js';
import { snapshotScreen, type XtermLike } from './screen.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (o: Record<string, unknown>) => XtermLike & {
    write(data: string, cb?: () => void): void;
  };
};

async function screenFrom(data: string, cols = 40, rows = 6) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => term.write(data, r));
  return snapshotScreen(term, DEFAULT_THEME);
}

describe('snapshotScreen', () => {
  it('captures plain text with default colours', async () => {
    const s = await screenFrom('hello');
    expect(s.cols).toBe(40);
    expect(s.rows).toBe(6);
    expect(
      s.cells[0]!
        .slice(0, 5)
        .map((c) => c.char)
        .join(''),
    ).toBe('hello');
    expect(s.cells[0]![0]!.fg).toBe(DEFAULT_THEME.foreground);
    expect(s.cells[0]![0]!.bg).toBe(DEFAULT_THEME.background);
  });

  it('resolves a palette foreground colour', async () => {
    const s = await screenFrom('\x1b[32mgreen\x1b[0m');
    expect(s.cells[0]![0]!.fg).toBe(DEFAULT_THEME.palette[2]);
  });

  it('resolves a truecolor foreground', async () => {
    const s = await screenFrom('\x1b[38;2;10;200;30mx\x1b[0m');
    expect(s.cells[0]![0]!.fg).toBe('#0ac81e');
  });

  it('resolves a palette background colour', async () => {
    const s = await screenFrom('\x1b[44mb\x1b[0m');
    expect(s.cells[0]![0]!.bg).toBe(DEFAULT_THEME.palette[4]);
  });

  it('coerces packed attribute integers to real booleans', async () => {
    const s = await screenFrom('\x1b[1mB\x1b[0m');
    // xterm returns 134217728 for bold, not true. A leaked integer here
    // would still be truthy, so assert the type, not just truthiness.
    expect(s.cells[0]![0]!.bold).toBe(true);
    expect(typeof s.cells[0]![0]!.bold).toBe('boolean');
  });

  it('swaps foreground and background for inverse video', async () => {
    const plain = await screenFrom('p');
    const inverse = await screenFrom('\x1b[7mp\x1b[0m');
    expect(inverse.cells[0]![0]!.fg).toBe(plain.cells[0]![0]!.bg);
    expect(inverse.cells[0]![0]!.bg).toBe(plain.cells[0]![0]!.fg);
  });

  it('marks wide characters and their continuation cells', async () => {
    const s = await screenFrom('漢字');
    expect(s.cells[0]![0]!.char).toBe('漢');
    expect(s.cells[0]![0]!.width).toBe(2);
    expect(s.cells[0]![1]!.width).toBe(0);
  });

  it('preserves box-drawing characters', async () => {
    const s = await screenFrom('┌─┐');
    expect(
      s.cells[0]!
        .slice(0, 3)
        .map((c) => c.char)
        .join(''),
    ).toBe('┌─┐');
  });

  it('produces a full rectangular grid', async () => {
    const s = await screenFrom('x', 20, 4);
    expect(s.cells).toHaveLength(4);
    for (const row of s.cells) expect(row).toHaveLength(20);
  });
});
