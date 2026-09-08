import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { captureTerminalDemo } from './capture.js';

function load(path: string) {
  const { script, diagnostics } = checkSchema(parseSource(readFileSync(path, 'utf8')));
  if (!script) throw new Error(`fixture invalid: ${JSON.stringify(diagnostics)}`);
  return script;
}

describe('captureTerminalDemo', () => {
  it('captures every scene and reports success', async () => {
    const result = await captureTerminalDemo(load('fixtures/terminal/demo.yaml'));
    expect(result.scenes.map((s) => s.id)).toEqual(['greet', 'build']);
    expect(result.ok, JSON.stringify(result.scenes, null, 2)).toBe(true);
  }, 90000);

  it('produces one asciicast per session, containing real output', async () => {
    const result = await captureTerminalDemo(load('fixtures/terminal/demo.yaml'));
    const cast = result.casts.cli;
    expect(cast).toBeDefined();
    expect(cast!.width).toBe(90);
    expect(cast!.events.length).toBeGreaterThan(0);

    // The cast holds the RAW PTY stream, so "hello autodemo" is not a
    // contiguous substring — it is emitted as
    //   \x1b[32mhello\x1b[0m \x1b[1mautodemo\x1b[0m
    // Turning that back into readable text is the renderer's job in
    // Phase 1b. Here we only prove real output was recorded.
    const raw = cast!.events.map((e) => e[2]).join('');
    expect(raw).toContain('hello');
    expect(raw).toContain('autodemo');
    expect(raw).toContain('build complete');
    expect(raw).toContain('\x1b['); // escapes preserved verbatim for replay
  }, 90000);

  it('shares one session across scenes rather than respawning', async () => {
    const result = await captureTerminalDemo(load('fixtures/terminal/demo.yaml'));
    expect(Object.keys(result.casts)).toEqual(['cli']);
  }, 90000);

  it('reports a failing assertion instead of throwing', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'this-text-is-never-printed' }];
    const result = await captureTerminalDemo(script);
    expect(result.ok).toBe(false);
    const scene = result.scenes.find((s) => s.id === 'greet')!;
    expect(scene.ok).toBe(false);
    expect(scene.assertions[0]!.detail).toContain('not found');
  }, 90000);

});

describe('captureDemo with a browser session', () => {
  const PORT = 34600;
  let server: import('node:child_process').ChildProcess;

  beforeAll(async () => {
    const { spawn } = await import('node:child_process');
    server = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      server.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('listening on')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }, 30000);

  afterAll(() => server.kill());

  it('captures browser scenes and stores frames', async () => {
    const { captureDemo } = await import('./capture.js');
    const result = await captureDemo(load('fixtures/browser/demo.yaml'));
    try {
      expect(result.scenes.map((s) => s.id)).toEqual(['open', 'order']);
      expect(result.ok, JSON.stringify(result.scenes, null, 2)).toBe(true);
      expect(result.frames.web).toBeDefined();
      expect(result.frames.web!.frames.length).toBeGreaterThan(0);
      expect(result.frames.web!.width).toBe(1280);
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync('.autodemo', { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 180000);

  it('still captures a terminal-only demo unchanged', async () => {
    const { captureDemo } = await import('./capture.js');
    const result = await captureDemo(load('fixtures/terminal/demo.yaml'));
    expect(result.ok).toBe(true);
    expect(Object.keys(result.casts)).toEqual(['cli']);
    expect(Object.keys(result.frames)).toEqual([]);
  }, 120000);
});

describe('abort on failure', () => {
  it('stops after the first failing scene instead of cascading', async () => {
    const { captureDemo } = await import('./capture.js');
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];

    const result = await captureDemo(script);

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBe(script.scenes[0]!.id);
    // The second scene must not have run: its failure would be caused by
    // the first, and cascading failures bury the real cause.
    expect(result.scenes).toHaveLength(1);
  }, 120000);

  it('runs every scene when told to continue', async () => {
    const { captureDemo } = await import('./capture.js');
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];

    const result = await captureDemo(script, { onSceneFail: 'continue' });

    expect(result.ok).toBe(false);
    expect(result.abortedAt).toBeNull();
    expect(result.scenes).toHaveLength(script.scenes.length);
  }, 120000);

  it('reports no abort for a passing demo', async () => {
    const { captureDemo } = await import('./capture.js');
    const result = await captureDemo(load('fixtures/terminal/demo.yaml'));
    expect(result.ok).toBe(true);
    expect(result.abortedAt).toBeNull();
  }, 120000);
});
