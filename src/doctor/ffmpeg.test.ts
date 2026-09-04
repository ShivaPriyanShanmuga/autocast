import { describe, it, expect } from 'vitest';
import { parseFfmpegVersion } from './ffmpeg.js';

const REAL = `ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers
built with gcc 14.2.0 (Rev1, Built by MSYS2 project)
configuration: --enable-gpl --enable-libx264 --enable-libx265 --enable-librubberband --enable-libass
`;

describe('parseFfmpegVersion', () => {
  it('extracts the version number', () => {
    expect(parseFfmpegVersion(REAL).version).toBe('7.1.1');
  });

  it('detects enabled libraries', () => {
    const { libs } = parseFfmpegVersion(REAL);
    expect(libs.has('libx264')).toBe(true);
    expect(libs.has('librubberband')).toBe(true);
    expect(libs.has('libvpx')).toBe(false);
  });

  it('returns a null version for unrecognisable output', () => {
    expect(parseFfmpegVersion('command not found').version).toBeNull();
  });

  it('returns no libs when there is no configuration line', () => {
    expect(parseFfmpegVersion('ffmpeg version 6.0').libs.size).toBe(0);
  });
});
