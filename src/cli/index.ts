#!/usr/bin/env node
import { runCli, type CliIO } from './run.js';

const io: CliIO = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

runCli(process.argv.slice(2), io).then(
  (code) => finish(code),
  (error: unknown) => {
    io.err(`autodemo: ${error instanceof Error ? error.message : String(error)}`);
    finish(2);
  },
);

/**
 * A live PTY keeps the event loop open (spec section 6.1), so setting
 * process.exitCode is not enough to end the process after a render. The
 * write callback fires once stdout has flushed, which matters when it is
 * a pipe rather than a TTY.
 */
function finish(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}
