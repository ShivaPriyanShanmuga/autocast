import { describe, it, expect } from 'vitest';
import { resolveShell, cleanEnv } from './shell.js';

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
