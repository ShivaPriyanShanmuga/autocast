import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateText } from './validate.js';

describe('validateText', () => {
  it('passes the flagship fixture with no errors', () => {
    const text = readFileSync('fixtures/mixed/demo.yaml', 'utf8');
    const ds = validateText(text);
    expect(ds.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('reports an undeclared session', () => {
    const text = readFileSync('fixtures/broken/undeclared-session.yaml', 'utf8');
    expect(validateText(text).map((d) => d.code)).toContain('L001');
  });

  it('reports an uncompilable regex', () => {
    const text = readFileSync('fixtures/broken/bad-regex.yaml', 'utf8');
    expect(validateText(text).map((d) => d.code)).toContain('S001');
  });

  it('reports a backend-mismatched step', () => {
    const text = readFileSync('fixtures/broken/wrong-backend.yaml', 'utf8');
    expect(validateText(text).map((d) => d.code)).toContain('L008');
  });

  it('reports a YAML syntax error and does not attempt lint', () => {
    const text = readFileSync('fixtures/broken/yaml-syntax.yaml', 'utf8');
    const codes = validateText(text).map((d) => d.code);
    expect(codes).toContain('Y001');
    expect(codes.some((c) => c.startsWith('L'))).toBe(false);
  });
});
