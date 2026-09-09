import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateText } from '../validate/validate.js';
import { hasErrors } from '../validate/diagnostic.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEMOS = join(ROOT, 'demos');

/**
 * The demos live outside fixtures/, so nothing else exercises them.
 *
 * Validating is free — it never captures anything — so this catches the
 * likely rot (a schema field renamed out from under a demo) for the cost
 * of parsing a file, without adding a browser render to a suite that is
 * already long.
 *
 * It deliberately does NOT render them. That would double the suite for
 * a guarantee the flagship fixture already provides.
 */
describe('the demos still validate', () => {
  const demos = existsSync(DEMOS)
    ? readdirSync(DEMOS, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

  it('there is at least one', () => {
    expect(demos.length).toBeGreaterThan(0);
  });

  for (const name of demos) {
    it(`${name} parses, matches the schema, and lints clean`, () => {
      const path = join(DEMOS, name, 'demo.yaml');
      expect(existsSync(path), `${name} has no demo.yaml`).toBe(true);

      const diagnostics = validateText(readFileSync(path, 'utf8'));
      const detail = diagnostics.map((d) => `${d.code} ${d.message}`).join('\n');
      expect(hasErrors(diagnostics), detail).toBe(false);
    });

    it(`${name} ships whatever its demo drives`, () => {
      // A demo whose app is missing would fail only at render time, which
      // is the expensive way to find out.
      const yaml = readFileSync(join(DEMOS, name, 'demo.yaml'), 'utf8');
      for (const m of yaml.matchAll(/\bnode\s+([\w./-]+\.mjs)\b/g)) {
        const script = m[1]!;
        expect(
          existsSync(join(DEMOS, name, script)),
          `${name}/demo.yaml runs ${script}, which does not exist`,
        ).toBe(true);
      }
    });
  }
});
