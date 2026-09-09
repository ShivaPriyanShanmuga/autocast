import { describe, it, expect } from 'vitest';
import { parseSource } from './parse.js';

const SAMPLE = `castscript: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
`;

describe('parseSource', () => {
  it('returns the parsed value', () => {
    const p = parseSource(SAMPLE);
    expect((p.value as Record<string, unknown>).castscript).toBe(1);
  });

  it('locates a top-level key', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['sessions'])).toEqual({ line: 4, col: 1 });
  });

  it('locates a nested scalar', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['output', 'path'])).toEqual({ line: 3, col: 9 });
  });

  it('locates an array element by index', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['scenes', 0, 'use'])).toEqual({ line: 9, col: 10 });
  });

  it('walks up to the parent when the path does not resolve', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['output', 'missing'])).toEqual(p.locate(['output']));
  });

  it('falls back to 1:1 for a wholly unresolvable path', () => {
    const p = parseSource(SAMPLE);
    expect(p.locate(['nope', 'nothing'])).toEqual({ line: 1, col: 1 });
  });

  it('reports YAML syntax errors with a location', () => {
    const p = parseSource('scenes:\n  - id: a\n   use: b\n');
    expect(p.syntaxErrors.length).toBeGreaterThan(0);
    expect(p.syntaxErrors[0]!.loc.line).toBeGreaterThan(0);
  });
});
