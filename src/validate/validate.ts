import type { Diagnostic } from './diagnostic.js';
import { lint } from './lint.js';
import { parseSource } from './parse.js';
import { checkSchema } from './schema-check.js';

/**
 * Full static validation. Lint only runs when the schema stage produced a
 * script — linting a shape we could not parse would produce noise, not
 * information.
 */
export function validateText(text: string): Diagnostic[] {
  const parsed = parseSource(text);
  const { diagnostics, script } = checkSchema(parsed);
  if (script === null) return diagnostics;
  return [...diagnostics, ...lint(script, parsed)];
}
