import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOutputPath } from './output-path.js';

const dir = mkdtempSync(join(tmpdir(), 'castscript-out-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('checkOutputPath', () => {
  it('accepts a path whose directory does not exist yet, and creates it', async () => {
    const p = join(dir, 'deep', 'nested', 'demo.mp4');
    await expect(checkOutputPath(p)).resolves.toBeUndefined();
    expect(existsSync(join(dir, 'deep', 'nested'))).toBe(true);
  });

  it('accepts overwriting an existing video', async () => {
    const p = join(dir, 'existing.mp4');
    writeFileSync(p, 'old video');
    await expect(checkOutputPath(p)).resolves.toBeUndefined();
    // Must NOT delete it — a failed capture should leave the old one
    // alone until there is something better to put there.
    expect(existsSync(p)).toBe(true);
  });

  it('rejects a path that is a directory, naming it', async () => {
    const p = join(dir, 'iam-a-dir.mp4');
    mkdirSync(p, { recursive: true });
    await expect(checkOutputPath(p)).rejects.toThrow(/directory/i);
    await expect(checkOutputPath(p)).rejects.toThrow('iam-a-dir.mp4');
  });

  it('rejects when the parent cannot be created', async () => {
    // A file standing where a directory needs to be.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    await expect(checkOutputPath(join(blocker, 'demo.mp4'))).rejects.toThrow(/cannot write/i);
  });

  it('says what to do, not just what went wrong', async () => {
    const p = join(dir, 'another-dir.mp4');
    mkdirSync(p, { recursive: true });
    await expect(checkOutputPath(p)).rejects.toThrow(/output\.path/);
  });
});
