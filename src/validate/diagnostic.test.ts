import { describe, it, expect } from 'vitest';
import { formatDiagnostics, hasErrors, type Diagnostic } from './diagnostic.js';

const d = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  severity: 'error',
  code: 'L001',
  message: 'something went wrong',
  loc: { line: 4, col: 7 },
  ...over,
});

describe('formatDiagnostics', () => {
  it('formats a diagnostic as file:line:col severity code message', () => {
    const text = formatDiagnostics('demo.yaml', [d()]);
    expect(text).toContain('demo.yaml:4:7');
    expect(text).toContain('error');
    expect(text).toContain('L001');
    expect(text).toContain('something went wrong');
  });

  it('summarises counts of both severities', () => {
    const text = formatDiagnostics('demo.yaml', [d(), d({ severity: 'warning', code: 'L004' })]);
    expect(text).toContain('1 error');
    expect(text).toContain('1 warning');
  });

  it('reports a clean file', () => {
    expect(formatDiagnostics('demo.yaml', [])).toContain('no problems found');
  });

  it('sorts by line then column', () => {
    const text = formatDiagnostics('demo.yaml', [
      d({ code: 'B', loc: { line: 9, col: 1 } }),
      d({ code: 'A', loc: { line: 2, col: 5 } }),
    ]);
    expect(text.indexOf('A')).toBeLessThan(text.indexOf('B'));
  });
});

describe('hasErrors', () => {
  it('is true when any diagnostic is an error', () => {
    expect(hasErrors([d({ severity: 'warning' }), d()])).toBe(true);
  });

  it('is false for warnings only', () => {
    expect(hasErrors([d({ severity: 'warning' })])).toBe(false);
  });
});
