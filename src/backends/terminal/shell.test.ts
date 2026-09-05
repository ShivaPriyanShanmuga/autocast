import { describe, it, expect } from 'vitest';
import { resolveShell, cleanEnv, checkSpawnHelper } from './shell.js';

const never = () => false;
const always = () => true;
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe('resolveShell', () => {
  it('uses COMSPEC on Windows', () => {
    expect(resolveShell('win32', { COMSPEC: 'C:\cmd.exe' }, never)).toBe('C:\cmd.exe');
  });

  it('falls back to cmd.exe on Windows without COMSPEC', () => {
    expect(resolveShell('win32', {}, never)).toBe('cmd.exe');
  });

  it('prefers SHELL when it exists', () => {
    expect(resolveShell('darwin', { SHELL: '/opt/fish' }, only('/opt/fish'))).toBe('/opt/fish');
  });

  it('ignores SHELL when the file does not exist', () => {
    // The reported macOS CI failure: SHELL names a shell that is not
    // installed, and node-pty reports only "posix_spawnp failed".
    const shell = resolveShell('darwin', { SHELL: '/nope/zsh' }, only('/bin/zsh'));
    expect(shell).toBe('/bin/zsh');
  });

  it('falls back through zsh then bash on macOS', () => {
    expect(resolveShell('darwin', {}, only('/bin/bash'))).toBe('/bin/bash');
    expect(resolveShell('darwin', {}, only('/bin/zsh', '/bin/bash'))).toBe('/bin/zsh');
  });

  it('ends at /bin/sh, which POSIX guarantees', () => {
    expect(resolveShell('linux', {}, never)).toBe('/bin/sh');
  });

  it('ignores an empty SHELL', () => {
    expect(resolveShell('linux', { SHELL: '' }, always)).toBe('/bin/zsh');
  });
});

describe('cleanEnv', () => {
  it('keeps string values', () => {
    expect(cleanEnv({ FOO: 'bar' }).FOO).toBe('bar');
  });

  it('drops non-string values that would break the spawn', () => {
    const dirty = { BAD: undefined } as unknown as Record<string, string>;
    expect('BAD' in cleanEnv(dirty)).toBe(false);
  });

  it('includes the ambient environment', () => {
    expect(Object.keys(cleanEnv()).length).toBeGreaterThan(0);
  });
});

describe('checkSpawnHelper', () => {
  it('is not required off macOS', async () => {
    const s = await checkSpawnHelper('linux', 'x64');
    expect(s.required).toBe(false);
    expect(s.executable).toBe(true);
  });

  it('is not required on Windows', async () => {
    expect((await checkSpawnHelper('win32', 'x64')).required).toBe(false);
  });

  it('is required on macOS and reports a path', async () => {
    // node-pty ships prebuilds/darwin-<arch>/spawn-helper and execs it.
    const s = await checkSpawnHelper('darwin', 'arm64');
    expect(s.required).toBe(true);
    expect(s.path).toContain('spawn-helper');
  });

  it('reports non-executable rather than throwing for a missing arch', async () => {
    const s = await checkSpawnHelper('darwin', 'not-a-real-arch');
    expect(s.required).toBe(true);
    expect(s.executable).toBe(false);
  });
});
