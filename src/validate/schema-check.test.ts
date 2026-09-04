import { describe, it, expect } from 'vitest';
import { parseSource } from './parse.js';
import { checkSchema } from './schema-check.js';

const VALID = `autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
    steps:
      - type: ls
`;

describe('checkSchema', () => {
  it('accepts a valid script and returns it parsed', () => {
    const r = checkSchema(parseSource(VALID));
    expect(r.diagnostics).toEqual([]);
    expect(r.script?.output.fps).toBe(30);
  });

  it('reports a YAML syntax error as Y001 and returns no script', () => {
    const r = checkSchema(parseSource('scenes:\n  - id: a\n   use: b\n'));
    expect(r.diagnostics[0]!.code).toBe('Y001');
    expect(r.script).toBeNull();
  });

  it('points a schema error at the offending line', () => {
    const bad = VALID.replace('backend: terminal', 'backend: telepathy');
    const r = checkSchema(parseSource(bad));
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0]!.code).toBe('S001');
    expect(r.diagnostics[0]!.loc.line).toBe(6);
    expect(r.script).toBeNull();
  });

  it('points a missing required key at its parent object', () => {
    const bad = VALID.replace('    use: api\n', '');
    const r = checkSchema(parseSource(bad));
    expect(r.diagnostics[0]!.code).toBe('S001');
    expect(r.diagnostics[0]!.loc.line).toBe(8);
  });

  it('includes the failing path in the message', () => {
    const bad = VALID.replace('autocast: 1', 'autocast: 2');
    const r = checkSchema(parseSource(bad));
    expect(r.diagnostics[0]!.message).toContain('autocast');
  });
});
