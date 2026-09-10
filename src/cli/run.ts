import { doctorCommand } from './doctor-command.js';
import { initCommand } from './init-command.js';
import { renderCommand } from './render-command.js';
import { schemaCommand } from './schema-command.js';
import { validateCommand } from './validate-command.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

/** Kept in step with package.json by a test; there is no build step to sync them. */
export const VERSION = '0.1.3';

const USAGE = `castscript ${VERSION} — agent-driven demo video recorder

Usage:
  castscript <command> [options]

Commands:
  init              Scaffold a demo script for this project
  render <file>     Capture and encode a demo to video
  validate <file>   Check a demo script without running it
  doctor            Check system dependencies
  schema            Print the demo-script JSON Schema

Options:
  --version         Print the version
  --help            Print this message`;

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  if (argv.includes('--version')) {
    io.out(VERSION);
    return 0;
  }

  if (argv.includes('--help') || argv[0] === 'help') {
    io.out(USAGE);
    return 0;
  }

  const command = argv[0];
  if (command === undefined) {
    io.err('castscript: no command given\n');
    io.err(USAGE);
    return 2;
  }

  if (command === 'init') {
    return initCommand(argv.slice(1), io);
  }

  if (command === 'validate') {
    return validateCommand(argv.slice(1), io);
  }

  if (command === 'doctor') {
    return doctorCommand(argv.slice(1), io);
  }

  if (command === 'schema') {
    return schemaCommand(argv.slice(1), io);
  }

  if (command === 'render') {
    return renderCommand(argv.slice(1), io);
  }

  io.err(`castscript: unknown command "${command}"\n`);
  io.err(USAGE);
  return 2;
}
