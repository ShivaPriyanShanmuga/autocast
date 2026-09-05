import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { probeFfmpeg } from './ffmpeg.js';

const requireCjs = createRequire(import.meta.url);

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

const nodePtyCheck: Check = {
  name: 'node-pty',
  async run() {
    try {
      const version = (requireCjs('node-pty/package.json') as { version: string }).version;
      requireCjs('node-pty');

      // Loading the binding is NOT enough: on macOS CI the module loaded
      // cleanly and every spawn then failed with "posix_spawnp failed".
      // Actually opening a terminal is the only honest check.
      const { openTerminalSession } = await import('../backends/terminal/session.js');
      const { resolveShell, checkSpawnHelper } = await import('../backends/terminal/shell.js');

      // Check the macOS helper BEFORE spawning: node-pty execs a separate
      // spawn-helper binary there, and if npm dropped its executable bit
      // the only symptom is a bare "posix_spawnp failed."
      const helper = await checkSpawnHelper();
      if (helper.required && !helper.executable) {
        return {
          name: 'node-pty',
          status: 'fail',
          detail: 'spawn-helper is not executable',
          hint: [
            '    node-pty execs a separate spawn-helper binary on macOS, and npm',
            '    does not reliably preserve its executable bit. Without it every',
            '    terminal spawn fails with a bare "posix_spawnp failed."',
            '',
            `    chmod +x "${helper.path ?? 'node_modules/node-pty/prebuilds/darwin-*/spawn-helper'}"`,
          ].join('\n'),
        };
      }

      const session = await openTerminalSession({ cols: 20, rows: 4 });
      await session.dispose();

      return { name: 'node-pty', status: 'ok', detail: `${version} (${resolveShell()})` };
    } catch (error) {
      return {
        name: 'node-pty',
        status: 'fail',
        detail: 'cannot open a terminal',
        hint: [
          // The FULL message, not its first line. openTerminalSession
          // deliberately reports the shell, cwd, platform and arch, and
          // taking only line one threw all of that away — which is
          // exactly what made the macOS failure hard to diagnose.
          ...(error instanceof Error ? error.message : String(error))
            .split('\n')
            .map((line) => `    ${line}`),
          '',
          '    autocast drives a real PTY for terminal scenes.',
          '    If the message above names a shell, set SHELL to one that exists.',
          '    node-pty ships prebuilt binaries for common platforms.',
          '    If yours is not covered, it must be built from source:',
          '    Windows:  install Visual Studio Build Tools (C++ workload)',
          '    macOS:    xcode-select --install',
          '    Linux:    sudo apt install build-essential python3',
          '    Then:     npm rebuild node-pty',
        ].join('\n'),
      };
    }
  },
};

const chromiumCheck: Check = {
  name: 'chromium',
  async run() {
    try {
      const { chromium } = (await import('playwright')) as {
        chromium: { executablePath(): string };
      };
      const path = chromium.executablePath();
      await access(path, constants.X_OK);
      return { name: 'chromium', status: 'ok', detail: path };
    } catch (error) {
      return {
        name: 'chromium',
        status: 'fail',
        detail: `browser binary not available: ${
          error instanceof Error ? error.message.split('\n')[0] : String(error)
        }`,
        hint: [
          '    autocast drives a real Chromium for browser scenes.',
          '    Install it with:',
          '      npx playwright install chromium',
        ].join('\n'),
      };
    }
  },
};

/**
 * Each phase registers only what it needs — reporting a dependency the
 * installed feature set does not use would not be truthful.
 */
export const CHECKS: Check[] = [
  ffmpegCheck,
  x264Check,
  rubberbandCheck,
  nodePtyCheck,
  chromiumCheck,
  cwdWritableCheck,
];

export async function runChecks(checks: readonly Check[] = CHECKS): Promise<CheckResult[]> {
  return Promise.all(checks.map((c) => c.run()));
}
