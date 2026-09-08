import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DemoScript } from '../schema/demo.js';
import type { CliIO } from './run.js';

export type ProjectKind = 'web' | 'cli';

/**
 * Guess what kind of demo this repo wants.
 *
 * A guess, and cheap to be wrong about — the scaffold is a starting
 * point the agent edits. A SILENT wrong guess is not cheap, so `init`
 * reports what it decided.
 */
export function detectProject(dir: string): ProjectKind {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    if (scripts.dev || scripts.start) return 'web';
  } catch {
    // No package.json, or not readable as JSON. Neither is an error
    // worth failing over; it just means we have nothing to go on.
  }
  return 'cli';
}

const SCHEMA_REF = '# yaml-language-server: $schema=./.autocast/schema.json';

function webScaffold(): string {
  return `${SCHEMA_REF}
autocast: 1

# Edit this, then:  npx autocast validate demo.yaml && npx autocast render demo.yaml
# The full schema:  npx autocast schema

output:
  path: docs/demo.mp4
  canvas: [1280, 720]
  fps: 30

defaults:
  settle: 750ms

sessions:
  web:
    backend: browser
    viewport: [1280, 720]

scenes:
  - id: open
    use: web
    narrate: "The app loads."
    steps:
      # Point this at your dev server, and start it before rendering.
      - goto: http://127.0.0.1:3000/
    assert:
      - no_console_errors: true
`;
}

function cliScaffold(): string {
  return `${SCHEMA_REF}
autocast: 1

# Edit this, then:  npx autocast validate demo.yaml && npx autocast render demo.yaml
# The full schema:  npx autocast schema

output:
  path: docs/demo.mp4
  canvas: [1280, 720]
  fps: 30

defaults:
  typing_speed: 55ms
  settle: 750ms

sessions:
  cli:
    backend: terminal
    cols: 100
    rows: 24

scenes:
  - id: run
    use: cli
    narrate: "Here is the tool running."
    steps:
      # Replace with a command that prints something worth watching.
      - type: "node --version"
      - key: Enter
      - wait_for:
          stdout: /v\\d+/
    assert:
      - stdout_matches: /v\\d+/
`;
}

export async function initCommand(argv: string[], io: CliIO): Promise<number> {
  const force = argv.includes('--force');
  const dirFlag = argv.indexOf('--dir');
  const dir = dirFlag === -1 ? process.cwd() : (argv[dirFlag + 1] ?? process.cwd());

  const scriptPath = join(dir, 'demo.yaml');
  if (existsSync(scriptPath) && !force) {
    io.err(
      `autocast init: ${scriptPath} already exists.\n` +
        '  Re-run with --force to replace it, or edit the existing script.',
    );
    return 1;
  }

  const kind = detectProject(dir);
  writeFileSync(scriptPath, kind === 'web' ? webScaffold() : cliScaffold());

  // The same schema `autocast schema` prints, from the same call. Two
  // copies that can drift is exactly the duplication section 9 rejected
  // MCP for; it would be no better for having been written to disk.
  const schemaDir = join(dir, '.autocast');
  mkdirSync(schemaDir, { recursive: true });
  writeFileSync(
    join(schemaDir, 'schema.json'),
    JSON.stringify(z.toJSONSchema(DemoScript, { io: 'input' }), null, 2) + '\n',
  );

  const reason =
    kind === 'web'
      ? 'package.json has a dev or start script'
      : 'no dev or start script found';

  io.out(
    [
      `autocast init — scaffolded a ${kind} demo (${reason})`,
      '',
      `  ${scriptPath}`,
      `  ${join(schemaDir, 'schema.json')}   (editor autocomplete)`,
      '',
      'Next:',
      '  1. Edit demo.yaml — the comments say what to replace.',
      '  2. npx autocast validate demo.yaml     (free, no capture)',
      '  3. npx autocast render demo.yaml       (records the video)',
      '',
      'If the guess was wrong, `npx autocast schema` describes both backends.',
    ].join('\n'),
  );
  return 0;
}
