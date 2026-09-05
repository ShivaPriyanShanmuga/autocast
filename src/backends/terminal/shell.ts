import { existsSync } from 'node:fs';

/**
 * Pick a shell that actually exists.
 *
 * `process.env.SHELL ?? '/bin/bash'` is not safe: SHELL may be unset,
 * or may name a shell that is not installed (a login shell recorded on
 * one machine, an image where bash was removed). macOS CI runners hit
 * exactly this and node-pty reports only "posix_spawnp failed", which
 * names neither the shell nor the reason.
 *
 * `/bin/sh` is the last resort because POSIX guarantees it.
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') return env.COMSPEC ?? 'cmd.exe';

  const candidates = [
    env.SHELL,
    '/bin/zsh', // macOS default since Catalina
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return '/bin/sh';
}

/**
 * node-pty requires every environment value to be a string. A single
 * non-string entry makes the spawn fail with an opaque error, so filter
 * rather than trusting the caller.
 */
export function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
