import { access, constants } from 'node:fs/promises';
import { probeFfmpeg } from './ffmpeg.js';

/**
 * 'skip' means we could not run the check, not that it passed or failed.
 * Reporting "librubberband: not available" when ffmpeg itself is absent
 * would assert something we never actually established.
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

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

/**
 * A check that can only be answered once ffmpeg has been located. When it
 * has not, the result is 'skip' with no remediation — fixing ffmpeg is the
 * one action that unblocks all of these, and repeating its install block
 * per dependent check is noise, not help.
 */
function ffmpegLibCheck(
  name: string,
  onMissing: (name: string) => CheckResult,
): Check {
  return {
    name,
    async run() {
      const info = await probeFfmpeg();
      if (info === null) {
        return { name, status: 'skip', detail: 'cannot check — ffmpeg not found' };
      }
      if (!info.libs.has(name)) return onMissing(name);
      return { name, status: 'ok', detail: 'enabled' };
    },
  };
}

const x264Check = ffmpegLibCheck('libx264', (name) => ({
  name,
  status: 'fail',
  detail: 'ffmpeg was built without libx264',
  hint: '    autocast encodes H.264 and this ffmpeg cannot. Install a full build:\n' +
    FFMPEG_INSTALL,
}));

const rubberbandCheck = ffmpegLibCheck('librubberband', (name) => ({
  name,
  status: 'warn',
  detail: 'not enabled in this ffmpeg build',
  hint:
    '    Narration time-stretching will be unavailable (spec section 7.1, lever 3).\n' +
    '    Silent demos are unaffected.',
}));

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
