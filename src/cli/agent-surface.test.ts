import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, VERSION } from './run.js';
import { probeVideo } from '../render/encoder.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
};

const ROOT = resolve(__dirname, '..', '..');

describe('the knowledge an agent is handed', () => {
  it('AGENTS.md names every command in the loop', () => {
    const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    for (const command of ['castscript init', 'castscript validate', 'castscript render', 'castscript schema']) {
      expect(text).toContain(command);
    }
  });

  it('AGENTS.md forbids looking at frames, in as many words', () => {
    // Section 3 constraint 2. It is the single most likely thing for a
    // well-meaning agent to do unprompted, so it has to be stated.
    const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(text).toMatch(/never open the video/i);
  });

  it('neither AGENTS.md nor the skill restates the schema', () => {
    // Section 9 rejected MCP partly for adding "a duplicated schema to
    // keep in sync". A copy in a doc is the same mistake, cheaper.
    for (const file of ['AGENTS.md', join('skills', 'castscript', 'SKILL.md')]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, file).toContain('castscript schema');
      expect(text, file).not.toContain('"$schema"');
      expect(text, file).not.toContain('additionalProperties');
    }
  });

  it('the skill has frontmatter saying WHEN to use it', () => {
    // Line endings normalised first. git converts these to CRLF on a
    // Windows checkout, and a test about CONTENT that fails on an
    // encoding difference is testing the wrong thing — this broke on
    // exactly that, on the platform it was written on.
    const text = readFileSync(join(ROOT, 'skills', 'castscript', 'SKILL.md'), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    const front = /^---\n([\s\S]*?)\n---/.exec(text);
    expect(front).not.toBeNull();
    expect(front![1]).toMatch(/^name:\s*castscript$/m);
    expect(front![1]).toMatch(/^description:\s*Use when/m);
  });

  it('both stay small enough to be worth loading', () => {
    // Roughly 2k tokens between them, per the section 9 budget.
    const total = ['AGENTS.md', join('skills', 'castscript', 'SKILL.md')].reduce(
      (n, f) => n + readFileSync(join(ROOT, f), 'utf8').length,
      0,
    );
    expect(total).toBeLessThan(12_000);
  });

  it('ships a licence and a readme', () => {
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true);
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toMatch(/castscript/);
  });
});

describe('phase 7 exit criterion', () => {
  it('a repo that has never seen castscript gets an mp4 from init to render', async () => {
    // The criterion executed rather than asserted by hand: nothing here
    // is explained to the caller, and no fixture is reused.
    const dir = mkdtempSync(join(tmpdir(), 'castscript-fresh-'));
    dirs.push(dir);

    const init = capture();
    expect(await runCli(['init', '--dir', dir], init.io)).toBe(0);
    expect(existsSync(join(dir, 'demo.yaml'))).toBe(true);

    // The scaffold's placeholder command exists everywhere, but pin the
    // output somewhere inside the scratch directory.
    const script = join(dir, 'demo.yaml');
    writeFileSync(
      script,
      readFileSync(script, 'utf8').replace(
        'docs/demo.mp4',
        // Forward slashes: a Windows path with backslashes in YAML is a
        // string full of escapes.
        join(dir, 'out.mp4').split('\\').join('/'),
      ),
    );

    const check = capture();
    expect(await runCli(['validate', script], check.io)).toBe(0);

    const render = capture();
    const code = await runCli(['render', script], render.io);
    expect(code, render.out.join('') + render.err.join('')).toBe(0);

    const probe = await probeVideo(join(dir, 'out.mp4'));
    expect(probe.codec).toBe('h264');
    expect(probe.frames).toBeGreaterThan(10);
  }, 300_000);
});

describe('what gets published', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    license?: string;
    repository?: unknown;
    files?: string[];
    bin?: Record<string, string>;
  };

  it('declares a licence and a repository', () => {
    expect(pkg.license).toBe('MIT');
    expect(pkg.repository).toBeDefined();
  });

  it('ships the build, the install fixup, and the agent knowledge', () => {
    expect(pkg.files).toContain('dist');
    // The macOS spawn-helper chmod runs from postinstall; without it a
    // published package is broken on macOS.
    expect(pkg.files).toContain('scripts');
    expect(pkg.files).toContain('AGENTS.md');
    expect(pkg.files).toContain('skills');
  });

  it('does not ship fixtures or design docs', () => {
    for (const unwanted of ['fixtures', 'docs', 'src']) {
      expect(pkg.files).not.toContain(unwanted);
    }
  });

  it('exposes the binary the docs tell people to run', () => {
    expect(pkg.bin?.castscript).toBeDefined();
  });
});

describe('version', () => {
  it('matches package.json, which nothing else enforces', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
