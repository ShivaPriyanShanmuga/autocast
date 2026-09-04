import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const isWindows = process.platform === 'win32';

/**
 * Terminate a process and its descendants.
 *
 * On Windows this deliberately uses taskkill rather than node-pty's
 * `.kill()`. See spec section 6.1: node-pty's ConPTY kill path spawns a
 * console-enumeration helper that dies with "AttachConsole failed"
 * whenever the parent has no attached console — always true when stdout
 * is redirected, and always true in CI.
 *
 * Resolves even when the process has already exited.
 */
export async function killTree(pid: number): Promise<void> {
  if (isWindows) {
    try {
      await run('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // taskkill exits non-zero when the pid is already gone.
    }
    return;
  }

  // POSIX: kill the process group if we can, then the process itself.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  if (isWindows) {
    try {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        windowsHide: true,
      });
      return stdout.includes(String(pid));
    } catch {
      return false;
    }
  }

  try {
    process.kill(pid, 0); // signal 0 tests existence without sending anything
    return true;
  } catch {
    return false;
  }
}
