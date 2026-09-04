import type { SourceLocation } from './parse.js';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** Stable identifier, e.g. "L001" for lint or "S001" for schema. */
  code: string;
  message: string;
  loc: SourceLocation;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatDiagnostics(file: string, diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return `${file}: no problems found`;
  }

  const sorted = [...diagnostics].sort(
    (a, b) => a.loc.line - b.loc.line || a.loc.col - b.loc.col,
  );

  const lines = sorted.map(
    (d) => `${file}:${d.loc.line}:${d.loc.col}  ${d.severity}  ${d.code}  ${d.message}`,
  );

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  lines.push('', `${plural(errors, 'error')}, ${plural(warnings, 'warning')}`);

  return lines.join('\n');
}
