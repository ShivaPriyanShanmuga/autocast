import { describe, it, expect } from 'vitest';
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

    // The cast holds the RAW PTY stream, so "hello autocast" is not a
    // contiguous substring — it is emitted as
    //   \x1b[32mhello\x1b[0m \x1b[1mautocast\x1b[0m
    // Turning that back into readable text is the renderer's job in
    // Phase 1b. Here we only prove real output was recorded.
    const raw = cast!.events.map((e) => e[2]).join('');
    expect(raw).toContain('hello');
    expect(raw).toContain('autocast');
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

  it('rejects a browser session with a clear phase message', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.sessions.web = { backend: 'browser' };
    await expect(captureTerminalDemo(script)).rejects.toThrow(/Phase 2/i);
  }, 30000);
});
