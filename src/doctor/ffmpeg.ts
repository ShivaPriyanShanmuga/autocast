import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FfmpegInfo {
  version: string | null;
  libs: ReadonlySet<string>;
}

let probeCache: Promise<FfmpegInfo | null> | undefined;

export function parseFfmpegVersion(stdout: string): FfmpegInfo {
  const version = /^ffmpeg version (\d+\.\d+(?:\.\d+)?)/m.exec(stdout)?.[1] ?? null;
  const config = /^\s*configuration:(.*)$/m.exec(stdout)?.[1] ?? '';
  const libs = new Set<string>();
  for (const m of config.matchAll(/--enable-(lib[a-z0-9]+)/g)) {
    libs.add(m[1]!);
  }
  return { version, libs };
}

/**
 * Returns null when ffmpeg is not on PATH or does not run.
 *
 * Memoized: several checks ask about the same ffmpeg build, and spawning
 * the binary once per check would be three processes for one answer.
 */
export function probeFfmpeg(): Promise<FfmpegInfo | null> {
  probeCache ??= (async () => {
    try {
      const { stdout } = await run('ffmpeg', ['-version'], { windowsHide: true });
      const info = parseFfmpegVersion(stdout);
      return info.version === null ? null : info;
    } catch {
      return null;
    }
  })();
  return probeCache;
}

/** Test-only: drop the memo so a test can simulate a different machine. */
export function resetFfmpegProbe(): void {
  probeCache = undefined;
}
