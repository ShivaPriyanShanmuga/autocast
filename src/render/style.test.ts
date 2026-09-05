import { describe, it, expect } from 'vitest';
import { resolveStyle, PLAIN } from './style.js';

describe('resolveStyle', () => {
  it('returns the plain style when style is absent', () => {
    expect(resolveStyle(undefined)).toEqual(PLAIN);
  });

  it('plain means no padding, no rounding and no background', () => {
    // An existing demo without style: must render exactly as before.
    expect(PLAIN.padding).toBe(0);
    expect(PLAIN.radius).toBe(0);
    expect(PLAIN.background.kind).toBe('none');
    expect(PLAIN.shadow).toBe(false);
  });

  it('reads a gradient background', () => {
    const s = resolveStyle({ background: { gradient: ['#111', '#222'], padding: 64 } });
    expect(s.background).toEqual({ kind: 'gradient', colors: ['#111', '#222'] });
    expect(s.padding).toBe(64);
  });

  it('reads a solid background', () => {
    const s = resolveStyle({ background: { color: '#0a0a0f', padding: 20 } });
    expect(s.background).toEqual({ kind: 'solid', color: '#0a0a0f' });
  });

  it('prefers a gradient when both are given', () => {
    const s = resolveStyle({ background: { gradient: ['#1', '#2'], color: '#3' } });
    expect(s.background.kind).toBe('gradient');
  });

  it('reads window radius and shadow', () => {
    const s = resolveStyle({ window: { radius: 12, shadow: true } });
    expect(s.radius).toBe(12);
    expect(s.shadow).toBe(true);
  });

  it('reads cursor size', () => {
    expect(resolveStyle({ cursor: { size: 1.5 } }).cursorSize).toBeCloseTo(1.5, 3);
  });

  it('defaults cursor size to 1 when unset', () => {
    expect(resolveStyle({ window: { radius: 4 } }).cursorSize).toBe(1);
  });

  it('gives padding a sensible default when a background is set without one', () => {
    // A background with zero padding would be invisible.
    const s = resolveStyle({ background: { gradient: ['#1', '#2'] } });
    expect(s.padding).toBeGreaterThan(0);
  });
});
