import { createRequire } from 'node:module';
import { CastRecorder, type CastLog } from './cast.js';
import { killTree, isProcessAlive } from './kill-tree.js';

// node-pty and @xterm/headless are CommonJS; createRequire keeps their
// types honest without fighting ESM interop.
const require = createRequire(import.meta.url);

interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

interface XtermTerminal {
  write(data: string, cb?: () => void): void;
  rows: number;
  buffer: {
    active: {
      length: number;
      getLine(i: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
}

export interface TerminalSessionOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  now?: () => number;
}

export interface TerminalSession {
  readonly pid: number;
  write(data: string): void;
  text(): Promise<string>;
  waitFor(pattern: RegExp, timeoutMs: number): Promise<boolean>;
  isAlive(): boolean;
  exitCode(): number | null;
  cast(): CastLog;
  dispose(): Promise<void>;
}

const DEFAULT_SHELL =
  process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL ?? '/bin/bash');

export async function openTerminalSession(
  opts: TerminalSessionOptions = {},
): Promise<TerminalSession> {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const now = opts.now ?? (() => Date.now());

  const pty = require('node-pty') as {
    spawn(file: string, args: string[], o: Record<string, unknown>): PtyProcess;
  };
  const { Terminal } = require('@xterm/headless') as {
    Terminal: new (o: Record<string, unknown>) => XtermTerminal;
  };

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const recorder = new CastRecorder(cols, rows, now);

  const proc = pty.spawn(DEFAULT_SHELL, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
  });

  let exited: number | null = null;
  let disposed = false;
  /** Serialises xterm writes so text() never reads a half-applied frame. */
  let writeQueue: Promise<void> = Promise.resolve();

  proc.onData((data) => {
    recorder.record(data);
    writeQueue = writeQueue.then(
      () => new Promise<void>((resolve) => term.write(data, resolve)),
    );
  });

  proc.onExit(({ exitCode }) => {
    exited = exitCode;
  });

  const readText = async (): Promise<string> => {
    await writeQueue;
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    return lines.join('\n');
  };

  const session: TerminalSession = {
    pid: proc.pid,

    write(data) {
      proc.write(data);
    },

    text: readText,

    async waitFor(pattern, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pattern.test(await readText())) return true;
        if (exited !== null) {
          // Give the final flush one more look before giving up.
          return pattern.test(await readText());
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },

    isAlive() {
      return exited === null && !disposed;
    },

    exitCode() {
      return exited;
    },

    cast() {
      return recorder.log();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // NEVER proc.kill() — see spec section 6.1.
      if (await isProcessAlive(proc.pid)) {
        await killTree(proc.pid);
      }
      await writeQueue;
    },
  };

  return session;
}
