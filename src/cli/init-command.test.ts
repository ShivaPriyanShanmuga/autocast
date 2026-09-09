import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand, detectProject } from './init-command.js';
import { schemaCommand } from './schema-command.js';
import { validateCommand } from './validate-command.js';

const dirs: string[] = [];
function scratch(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'castscript-init-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
};

describe('detectProject', () => {
  it('calls a package with a dev script a web project', () => {
    const dir = scratch({ 'package.json': '{"scripts":{"dev":"vite"}}' });
    expect(detectProject(dir)).toBe('web');
  });

  it('accepts start as well as dev', () => {
    const dir = scratch({ 'package.json': '{"scripts":{"start":"node server.js"}}' });
    expect(detectProject(dir)).toBe('web');
  });

  it('falls back to cli with no package.json', () => {
    expect(detectProject(scratch())).toBe('cli');
  });

  it('falls back to cli for a package with neither script', () => {
    const dir = scratch({ 'package.json': '{"scripts":{"test":"vitest"}}' });
    expect(detectProject(dir)).toBe('cli');
  });

  it('does not throw on unreadable json', () => {
    const dir = scratch({ 'package.json': '{ not json' });
    expect(detectProject(dir)).toBe('cli');
  });
});

describe('initCommand', () => {
  it('writes a demo script and the schema', async () => {
    const dir = scratch();
    const { io: cio } = io();
    expect(await initCommand(['--dir', dir], cio)).toBe(0);
    expect(existsSync(join(dir, 'demo.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.castscript', 'schema.json'))).toBe(true);
  });

  it('scaffolds something that validates unedited', async () => {
    // An agent's first render must not fail on the template we handed it.
    const dir = scratch();
    const { io: cio } = io();
    await initCommand(['--dir', dir], cio);

    const v = io();
    expect(await validateCommand([join(dir, 'demo.yaml')], v.io)).toBe(0);
  });

  it('writes exactly the schema `castscript schema` prints', async () => {
    // Two copies that can drift is the duplication section 9 rejected
    // MCP for. They must come from one place.
    const dir = scratch();
    const { io: cio } = io();
    await initCommand(['--dir', dir], cio);

    const s = io();
    await schemaCommand([], s.io);
    expect(readFileSync(join(dir, '.castscript', 'schema.json'), 'utf8').trim()).toBe(
      s.out.join('').trim(),
    );
  });

  it('refuses to clobber an existing demo script', async () => {
    const dir = scratch({ 'demo.yaml': 'castscript: 1 # hand written\n' });
    const { io: cio, err } = io();
    expect(await initCommand(['--dir', dir], cio)).not.toBe(0);
    expect(readFileSync(join(dir, 'demo.yaml'), 'utf8')).toContain('hand written');
    expect(err.join('')).toMatch(/--force/);
  });

  it('overwrites when asked', async () => {
    const dir = scratch({ 'demo.yaml': 'castscript: 1 # hand written\n' });
    const { io: cio } = io();
    expect(await initCommand(['--dir', dir, '--force'], cio)).toBe(0);
    expect(readFileSync(join(dir, 'demo.yaml'), 'utf8')).not.toContain('hand written');
  });

  it('says what it detected, so a wrong guess is visible', async () => {
    const dir = scratch({ 'package.json': '{"scripts":{"dev":"vite"}}' });
    const { io: cio, out } = io();
    await initCommand(['--dir', dir], cio);
    expect(out.join('')).toMatch(/web/);
  });

  it('points the editor at the schema it just wrote', async () => {
    const dir = scratch();
    const { io: cio } = io();
    await initCommand(['--dir', dir], cio);
    expect(readFileSync(join(dir, 'demo.yaml'), 'utf8')).toContain('yaml-language-server');
  });

  it('tells the agent what to run next', async () => {
    const dir = scratch();
    const { io: cio, out } = io();
    await initCommand(['--dir', dir], cio);
    const text = out.join('');
    expect(text).toMatch(/castscript validate/);
    expect(text).toMatch(/castscript render/);
  });
});
