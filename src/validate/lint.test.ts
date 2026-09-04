import { describe, it, expect } from 'vitest';
import { parseSource } from './parse.js';
import { checkSchema } from './schema-check.js';
import { lint } from './lint.js';

function lintYaml(text: string) {
  const parsed = parseSource(text);
  const { script, diagnostics } = checkSchema(parsed);
  if (!script) throw new Error(`fixture failed schema: ${JSON.stringify(diagnostics)}`);
  return lint(script, parsed);
}

const codes = (text: string) => lintYaml(text).map((d) => d.code);

const BASE = `autocast: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
  web:
    backend: browser
scenes:
`;

describe('lint', () => {
  it('L001: flags a scene using an undeclared session', () => {
    const c = codes(
      BASE +
        `  - id: a
    use: nope
    assert:
      - process_alive: true
`,
    );
    expect(c).toContain('L001');
  });

  it('L002: flags a layout referencing an undeclared session', () => {
    const c = codes(
      BASE +
        `  - id: a
    use: api
    layout:
      primary: ghost
    assert:
      - process_alive: true
`,
    );
    expect(c).toContain('L002');
  });

  it('L003: flags duplicate scene ids', () => {
    const c = codes(
      BASE +
        `  - id: dup
    use: api
    assert:
      - process_alive: true
  - id: dup
    use: web
    assert:
      - visible: ".x"
`,
    );
    expect(c).toContain('L003');
  });

  it('L004: warns on a scene with no assertions', () => {
    const c = codes(
      BASE +
        `  - id: a
    use: api
    steps:
      - type: ls
`,
    );
    expect(c).toContain('L004');
  });

  it('L005: warns when sleep is used', () => {
    const c = codes(
      BASE +
        `  - id: a
    use: api
    steps:
      - sleep: 500ms
    assert:
      - process_alive: true
`,
    );
    expect(c).toContain('L005');
  });

  it('L006: warns about an unused session', () => {
    const c = codes(
      BASE +
        `  - id: a
    use: api
    assert:
      - process_alive: true
`,
    );
    expect(c).toContain('L006');
  });

  it('L007: warns about narration over the word ceiling', () => {
    const long = 'word '.repeat(130).trim();
    const c = codes(
      BASE +
        `  - id: a
    use: api
    narrate: "${long}"
    assert:
      - process_alive: true
`,
    );
    expect(c).toContain('L007');
  });

  it('L008: flags a browser step in a terminal session', () => {
    const c = codes(
      BASE +
        `  - id: a
    use: api
    steps:
      - goto: http://localhost:3000
    assert:
      - process_alive: true
`,
    );
    expect(c).toContain('L008');
  });

  it('L009: flags a terminal assertion in a browser session', () => {
    const c = codes(
      BASE +
        `  - id: a
    use: web
    assert:
      - process_alive: true
`,
    );
    expect(c).toContain('L009');
  });

  it('is silent on a clean script', () => {
    const c = codes(
      BASE +
        `  - id: boot
    use: api
    steps:
      - type: npm run dev
      - wait_for:
          stdout: /listening/
    assert:
      - process_alive: true
  - id: order
    use: web
    steps:
      - goto: http://localhost:3000
    assert:
      - visible: ".ok"
`,
    );
    expect(c).toEqual([]);
  });

  it('gives every diagnostic a real source location', () => {
    const ds = lintYaml(
      BASE +
        `  - id: a
    use: nope
    assert:
      - process_alive: true
`,
    );
    expect(ds.every((d) => d.loc.line > 1)).toBe(true);
  });
});
