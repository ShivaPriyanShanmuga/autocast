import { createRequire } from 'node:module';
import { CastRecorder, type CastLog } from './cast.js';
import { killTree, isProcessAlive } from './kill-tree.js';
import { cleanEnv, resolveShell } from './shell.js';

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
  /**
   * Poll until `predicate` accepts the rendered text. Needed for checks a
   * RegExp cannot express reliably — notably anything that must survive
   * the terminal wrapping a long line, which inserts a newline mid-token.
   */
  waitUntil(predicate: (text: string) => boolean, timeoutMs: number): Promise<boolean>;
  isAlive(): boolean;
  exitCode(): number | null;
  cast(): CastLog;
  dispose(): Promise<void>;
}


/** Output must be this quiet before a shell counts as ready. */
const SHELL_QUIET_MS = 150;
/** Never wait longer than this, even for a silent shell. */
const SHELL_READY_TIMEOUT_MS = 5000;

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

  const shell = resolveShell();
  const cwd = opts.cwd ?? process.cwd();

  let proc: PtyProcess;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: cleanEnv(opts.env),
    });
  } catch (error) {
    // node-pty reports only "posix_spawnp failed", which names neither
    // the shell nor the reason. Say what we actually tried.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not start a terminal: ${detail}
` +
        `  shell:    ${shell}
` +
        `  cwd:      ${cwd}
` +
        `  platform: ${process.platform} ${process.arch}
` +
        '  Set SHELL to a shell that exists, or check the session cwd.',
    );
  }

  let exited: number | null = null;
  let disposed = false;
  let lastDataAt: number | null = null;
  /** Serialises xterm writes so text() never reads a half-applied frame. */
  let writeQueue: Promise<void> = Promise.resolve();

  proc.onData((data) => {
    lastDataAt = Date.now();
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

  // Wait for the shell to actually be ready before handing it over.
  //
  // pty.spawn returns as soon as the process exists, not when the shell
  // can accept input. Typing into that gap loses characters: a test
  // caught it twice under load, reading back a Windows banner where the
  // typed command should have been. A real demo on a busy machine would
  // lose its first command the same way, and produce a video of nothing
  // happening.
  //
  // Shell-agnostic by design: wait for output to arrive and then go
  // quiet, rather than matching a prompt, because every shell's prompt
  // is different and users can set their own.
  await new Promise<void>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const settled = lastDataAt !== null && Date.now() - lastDataAt >= SHELL_QUIET_MS;
      // A shell that never says anything must not hang the render.
      if (settled || Date.now() - started >= SHELL_READY_TIMEOUT_MS) {
        clearInterval(timer);
        resolve();
      }
    }, 25);
    timer.unref?.();
  });

  const session: TerminalSession = {
    pid: proc.pid,

    write(data) {
      proc.write(data);
    },

    text: readText,

    async waitUntil(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(await readText())) return true;
        if (exited !== null) {
          // Give the final flush one more look before giving up.
          return predicate(await readText());
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },

    async waitFor(pattern, timeoutMs) {
      return session.waitUntil((text) => pattern.test(text), timeoutMs);
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
