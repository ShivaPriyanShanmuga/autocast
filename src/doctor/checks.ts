import { access, constants } from 'node:fs/promises';
import { probeFfmpeg } from './ffmpeg.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Multi-line, copy-pasteable remediation. Present when status is not 'ok'. */
  hint?: string;
}

export interface Check {
  name: string;
  run(): Promise<CheckResult>;
}

const FFMPEG_INSTALL = [
  '    autocast needs ffmpeg to encode video.',
  '    Windows:  winget install Gyan.FFmpeg',
  '    macOS:    brew install ffmpeg',
  '    Linux:    sudo apt install ffmpeg   (or your distro equivalent)',
].join('\n');

const ffmpegCheck: Check = {
  name: 'ffmpeg',
  async run() {
    const info = await probeFfmpeg();
    if (info === null) {
      return { name: 'ffmpeg', status: 'fail', detail: 'not found on PATH', hint: FFMPEG_INSTALL };
    }
    return { name: 'ffmpeg', status: 'ok', detail: info.version ?? 'unknown version' };
  },
};

const x264Check: Check = {
  name: 'libx264',
  async run() {
    const info = await probeFfmpeg();
    if (info === null) {
      return {
        name: 'libx264',
        status: 'fail',
        detail: 'ffmpeg not available',
        hint: FFMPEG_INSTALL,
      };
    }
    if (!info.libs.has('libx264')) {
      return {
        name: 'libx264',
        status: 'fail',
        detail: 'ffmpeg was built without libx264',
        hint: '    autocast encodes H.264. Install a full ffmpeg build:\n' + FFMPEG_INSTALL,
      };
    }
    return { name: 'libx264', status: 'ok', detail: 'enabled' };
  },
};

const rubberbandCheck: Check = {
  name: 'librubberband',
  async run() {
    const info = await probeFfmpeg();
    if (info === null || !info.libs.has('librubberband')) {
      return {
        name: 'librubberband',
        status: 'warn',
        detail: 'not available',
        hint:
          '    Narration time-stretching will be unavailable (spec section 7.1, lever 3).\n' +
          '    Silent demos are unaffected.',
      };
    }
    return { name: 'librubberband', status: 'ok', detail: 'enabled' };
  },
};

const cwdWritableCheck: Check = {
  name: 'cwd writable',
  async run() {
    try {
      await access(process.cwd(), constants.W_OK);
      return { name: 'cwd writable', status: 'ok', detail: process.cwd() };
    } catch {
      return {
        name: 'cwd writable',
        status: 'fail',
        detail: `cannot write to ${process.cwd()}`,
        hint: '    autocast writes intermediates to .autocast/ in the working directory.',
      };
    }
  },
};

/**
 * Phase 0 registers only what Phase 0 needs. Phase 1 adds a node-pty
 * check and Phase 2 adds Playwright chromium — reporting a dependency
 * the installed feature set does not use would not be truthful.
 */
export const CHECKS: Check[] = [ffmpegCheck, x264Check, rubberbandCheck, cwdWritableCheck];

export async function runChecks(checks: readonly Check[] = CHECKS): Promise<CheckResult[]> {
  return Promise.all(checks.map((c) => c.run()));
}
