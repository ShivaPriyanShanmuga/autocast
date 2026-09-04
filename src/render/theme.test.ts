import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, paletteColor, rgbToHex } from './theme.js';

describe('rgbToHex', () => {
  it('unpacks a 24-bit integer as xterm reports it', () => {
    // 706590 === 0x0AC81E === rgb(10, 200, 30)
    expect(rgbToHex(706590)).toBe('#0ac81e');
  });

  it('pads short components', () => {
    expect(rgbToHex(0x010203)).toBe('#010203');
  });

  it('handles black and white', () => {
    expect(rgbToHex(0x000000)).toBe('#000000');
    expect(rgbToHex(0xffffff)).toBe('#ffffff');
  });
});

describe('paletteColor', () => {
  it('returns the named colours for 0-15', () => {
    expect(paletteColor(DEFAULT_THEME, 0)).toBe(DEFAULT_THEME.palette[0]);
    expect(paletteColor(DEFAULT_THEME, 2)).toMatch(/^#[0-9a-f]{6}$/);
    expect(paletteColor(DEFAULT_THEME, 15)).toBe(DEFAULT_THEME.palette[15]);
  });

  it('computes the 6x6x6 cube for 16-231', () => {
    expect(paletteColor(DEFAULT_THEME, 16)).toBe('#000000');
    expect(paletteColor(DEFAULT_THEME, 231)).toBe('#ffffff');
    expect(paletteColor(DEFAULT_THEME, 100)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('computes the greyscale ramp for 232-255', () => {
    const dark = paletteColor(DEFAULT_THEME, 232);
    const light = paletteColor(DEFAULT_THEME, 255);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(parseInt(light.slice(1), 16)).toBeGreaterThan(parseInt(dark.slice(1), 16));
  });

  it('clamps out-of-range indices instead of returning undefined', () => {
    expect(paletteColor(DEFAULT_THEME, -1)).toMatch(/^#[0-9a-f]{6}$/);
    expect(paletteColor(DEFAULT_THEME, 999)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('DEFAULT_THEME', () => {
  it('has 16 palette entries and readable defaults', () => {
    expect(DEFAULT_THEME.palette).toHaveLength(16);
    expect(DEFAULT_THEME.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(DEFAULT_THEME.foreground).toMatch(/^#[0-9a-f]{6}$/);
  });
});
