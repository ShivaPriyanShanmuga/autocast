import { describe, it, expect } from 'vitest';
import type { CastLog } from '../backends/terminal/cast.js';
import { CastPlayer } from './cast-player.js';
import { DEFAULT_THEME } from './theme.js';

function cast(events: Array<[number, string]>): CastLog {
  return {
    version: 2,
    width: 40,
    height: 6,
    timestamp: 1788570639,
    startedAtMs: 1788570639123,
    events: events.map(([t, d]) => [t, 'o', d]),
  };
}

const row = (p: CastPlayer, i: number) =>
  p.screen().cells[i]!.map((c) => c.char).join('').trimEnd();

describe('CastPlayer', () => {
  it('shows nothing before the first event', async () => {
    const p = new CastPlayer(cast([[1, 'hello']]), DEFAULT_THEME);
    await p.advanceTo(0.5);
    expect(row(p, 0)).toBe('');
  });

  it('applies events up to the requested time', async () => {
    const p = new CastPlayer(cast([[0.1, 'first'], [1.0, '\r\nsecond']]), DEFAULT_THEME);
    await p.advanceTo(0.5);
    expect(row(p, 0)).toBe('first');
    expect(row(p, 1)).toBe('');
  });

  it('accumulates state as time advances', async () => {
    const p = new CastPlayer(cast([[0.1, 'first'], [1.0, '\r\nsecond']]), DEFAULT_THEME);
    await p.advanceTo(0.5);
    await p.advanceTo(1.5);
    expect(row(p, 0)).toBe('first');
    expect(row(p, 1)).toBe('second');
  });

  it('is idempotent for the same time', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(1);
    const a = row(p, 0);
    await p.advanceTo(1);
    expect(row(p, 0)).toBe(a);
  });

  it('resolves a carriage-return redraw', async () => {
    const p = new CastPlayer(cast([[0.1, 'p  10%'], [0.2, '\rp 100%']]), DEFAULT_THEME);
    await p.advanceTo(1);
    expect(row(p, 0)).toBe('p 100%');
  });

  it('reports its position', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(2.5);
    expect(p.position).toBeCloseTo(2.5, 6);
  });

  it('rejects going backwards rather than showing a wrong screen', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(2);
    await expect(p.advanceTo(1)).rejects.toThrow(/forward|backward/i);
  });

  it('carries the cast geometry into the screen', async () => {
    const p = new CastPlayer(cast([[0.1, 'x']]), DEFAULT_THEME);
    await p.advanceTo(1);
    expect(p.screen().cols).toBe(40);
    expect(p.screen().rows).toBe(6);
  });

  it('handles an empty cast', async () => {
    const p = new CastPlayer(cast([]), DEFAULT_THEME);
    await p.advanceTo(5);
    expect(row(p, 0)).toBe('');
  });

  it('catches up across a skipped span, as an interleaved scene needs', async () => {
    // The terminal is not drawn during a browser scene, then must show
    // everything that happened meanwhile when it comes back on screen.
    const p = new CastPlayer(
      cast([[0.1, 'one'], [1.0, '\r\ntwo'], [2.0, '\r\nthree']]),
      DEFAULT_THEME,
    );
    await p.advanceTo(0.2);
    await p.advanceTo(2.5); // skip straight past the middle
    expect(row(p, 1)).toBe('two');
    expect(row(p, 2)).toBe('three');
  });
});
