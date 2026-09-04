import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { killTree, isProcessAlive } from './kill-tree.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnForever() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

describe('killTree', () => {
  it('reports a live process as alive', async () => {
    const child = spawnForever();
    await sleep(300);
    expect(await isProcessAlive(child.pid!)).toBe(true);
    await killTree(child.pid!);
  }, 20000);

  it('kills a process that would otherwise never exit', async () => {
    const child = spawnForever();
    await sleep(300);
    await killTree(child.pid!);
    await sleep(600);
    expect(await isProcessAlive(child.pid!)).toBe(false);
  }, 20000);

  it('resolves without throwing when the pid is already gone', async () => {
    const child = spawnForever();
    await sleep(300);
    await killTree(child.pid!);
    await sleep(600);
    await expect(killTree(child.pid!)).resolves.toBeUndefined();
  }, 20000);

  it('reports a non-existent pid as not alive', async () => {
    expect(await isProcessAlive(0x7ffffff0)).toBe(false);
  }, 20000);
});
