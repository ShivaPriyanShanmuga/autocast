import { validateCommand } from './validate-command.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export const VERSION = '0.0.0';

const USAGE = `autocast ${VERSION} — agent-driven demo video recorder

Usage:
  autocast <command> [options]

Commands:
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
    io.err('autocast: no command given\n');
    io.err(USAGE);
    return 2;
  }

  if (command === 'validate') {
    return validateCommand(argv.slice(1), io);
  }

  io.err(`autocast: unknown command "${command}"\n`);
  io.err(USAGE);
  return 2;
}
