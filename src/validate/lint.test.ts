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

const BASE = `castscript: 1
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

describe('L008 caption overflow', () => {
  const withNarration = (narrate: string): string =>
    BASE + `  - id: boot
    use: api
    narrate: "${narrate}"
`;

  const LONG = Array.from({ length: 40 }, () => 'wordy').join(' ');

  it('warns when narration cannot fit in the caption lines', () => {
    expect(codes(withNarration(LONG))).toContain('L008');
  });

  it('says nothing about narration that fits', () => {
    expect(codes(withNarration('First we start the order API.'))).not.toContain('L008');
  });

  it('names the scene and points at the narration', () => {
    const d = lintYaml(withNarration(LONG)).find((x) => x.code === 'L008')!;
    expect(d.message).toContain('boot');
    // Points at the narration line itself, not the top of the file.
    expect(d.loc.line).toBeGreaterThan(1);
  });
});

describe('L010 heteronyms in spoken narration', () => {
  const withVoice = (narrate: string, extra = '') =>
    `castscript: 1
output:
  path: docs/demo.mp4
voice:
  enabled: true
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
    narrate: "${narrate}"
${extra}`;

  it('warns when narration contains a word the engine may mispronounce', () => {
    // Measured, not guessed: espeak renders "live in about two seconds"
    // as lˈɪv — the verb — which is what shipped in the demo.
    const d = lintYaml(withVoice('And there it is, live in about two seconds.'));
    const found = d.find((x) => x.code === 'L010');
    expect(found).toBeDefined();
    expect(found!.message).toMatch(/live/);
    expect(found!.message).toMatch(/speak:/);
  });

  it('is satisfied by a speak: override', () => {
    const d = lintYaml(
      withVoice('And there it is, live in about two seconds.', '    speak: "And there it is, lyve in about two seconds."\n'),
    );
    expect(d.find((x) => x.code === 'L010')).toBeUndefined();
  });

  it('stays quiet when nothing is spoken', () => {
    // Captions show the word as written, so there is no pronunciation to
    // get wrong. Warning here would be noise on every silent demo.
    const silent = `castscript: 1
output:
  path: docs/demo.mp4
sessions:
  api:
    backend: terminal
scenes:
  - id: boot
    use: api
    narrate: "we go live in about two seconds"
`;
    expect(lintYaml(silent).find((x) => x.code === 'L010')).toBeUndefined();
  });

  it('does not fire on a word that merely contains a heteronym', () => {
    // "delivery" contains "live"; "already" contains "read".
    const d = lintYaml(withVoice('The delivery already completed.'));
    expect(d.find((x) => x.code === 'L010')).toBeUndefined();
  });

  it('says nothing about ordinary narration', () => {
    const d = lintYaml(withVoice('First we start the shipboard server.'));
    expect(d.find((x) => x.code === 'L010')).toBeUndefined();
  });
});
