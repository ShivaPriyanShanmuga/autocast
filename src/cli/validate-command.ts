import { readFileSync } from 'node:fs';
import { formatDiagnostics, hasErrors } from '../validate/diagnostic.js';
import { validateText } from '../validate/validate.js';
import type { CliIO } from './run.js';

export async function validateCommand(argv: string[], io: CliIO): Promise<number> {
  const strict = argv.includes('--strict');
  const file = argv.find((a) => !a.startsWith('--'));

  if (file === undefined) {
    io.err('autocast validate: expects a file\n\nUsage: autocast validate [--strict] <file>');
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    io.err(
      `autocast validate: cannot read ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }

  const diagnostics = validateText(text);
  io.out(formatDiagnostics(file, diagnostics));

  if (hasErrors(diagnostics)) return 1;
  if (strict && diagnostics.length > 0) return 1;
  return 0;
}
