import { DemoScript } from '../schema/demo.js';
import type { Diagnostic } from './diagnostic.js';
import type { ParsedSource } from './parse.js';

export interface SchemaCheckResult {
  diagnostics: Diagnostic[];
  script: DemoScript | null;
}

export function checkSchema(parsed: ParsedSource): SchemaCheckResult {
  if (parsed.syntaxErrors.length > 0) {
    return {
      script: null,
      diagnostics: parsed.syntaxErrors.map((e) => ({
        severity: 'error' as const,
        code: 'Y001',
        message: e.message,
        loc: e.loc,
      })),
    };
  }

  const result = DemoScript.safeParse(parsed.value);
  if (result.success) {
    return { diagnostics: [], script: result.data };
  }

  const diagnostics = result.error.issues.map((issue): Diagnostic => {
    const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)) as Array<
      string | number
    >;
    const where = path.length > 0 ? `${path.join('.')}: ` : '';
    return {
      severity: 'error',
      code: 'S001',
      message: `${where}${issue.message}`,
      loc: parsed.locate(path),
    };
  });

  return { diagnostics, script: null };
}
