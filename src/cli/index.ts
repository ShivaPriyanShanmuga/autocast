#!/usr/bin/env node
import { runCli, type CliIO } from './run.js';

const io: CliIO = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

runCli(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    io.err(`autocast: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
