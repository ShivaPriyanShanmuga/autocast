import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { probeVideo } from '../render/encoder.js';
import { renderDemo, formatRenderReport } from './render.js';
import { SCENE_TAIL_SEC } from '../render/composition.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-render-'));
afterAll(() =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
);

function load(path: string) {
  const { script, diagnostics } = checkSchema(parseSource(readFileSync(path, 'utf8')));
  if (!script) throw new Error(`fixture invalid: ${JSON.stringify(diagnostics)}`);
  return script;
}

describe('renderDemo', () => {
  it('produces a playable mp4 of the terminal fixture', async () => {
    const out = join(dir, 'demo.mp4');
    const report = await renderDemo(load('fixtures/terminal/demo.yaml'), { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(report.frames).toBeGreaterThan(30);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
  }, 180000);

  it('reports failure when an assertion fails', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const out = join(dir, 'failed.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok).toBe(false);
    expect(report.scenes[0]!.assertions[0]!.ok).toBe(false);
  }, 180000);
});

describe('formatRenderReport', () => {
  it('renders a readable summary naming each scene', () => {
    const text = formatRenderReport({
      ok: false,
      outputPath: 'docs/demo.mp4',
      frames: 120,
      durationSec: 4,
      scenes: [
        { id: 'greet', ok: true, assertions: [{ name: 'stdout_contains', ok: true }] },
        {
          id: 'build',
          ok: false,
          assertions: [{ name: 'stdout_matches', ok: false, detail: 'no match' }],
        },
      ],
    });
    expect(text).toContain('greet');
    expect(text).toContain('build');
    expect(text).toContain('no match');
    expect(text).toContain('FAILED');
  });
});

describe('renderDemo with a browser session', () => {
  const PORT = 34601;
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

  it('produces a playable mp4 of the web fixture', async () => {
    const script = load('fixtures/browser/demo.yaml');
    script.scenes[0]!.steps![0] = { goto: `http://127.0.0.1:${PORT}/` };

    const out = join(dir, 'browser.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(report.frames).toBeGreaterThan(30);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
  }, 240000);

});


/**
 * The flagship starts a server on a fixed port from inside the demo, so
 * two tests rendering it concurrently collide on that port. Vitest runs
 * files in parallel, so every flagship render needs its own port.
 */
function loadFlagshipOnPort(port: number) {
  const { writeFileSync, readFileSync: read } = require('node:fs') as typeof import('node:fs');
  const yaml = read('fixtures/flagship/demo.yaml', 'utf8').replace(/34700/g, String(port));
  const path = join(dir, `flagship-${port}.yaml`);
  writeFileSync(path, yaml);
  return load(path);
}

describe('renderDemo with mixed sessions', () => {
  it('renders the flagship as one continuous mp4 and holds the step-less scene', async () => {
    const script = loadFlagshipOnPort(34710);
    const out = join(dir, 'flagship.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(report.scenes.map((s) => s.id)).toEqual(['boot', 'order', 'logs']);
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
    expect(report.frames).toBeGreaterThan(90);

    // The `logs` scene has no steps; without a minimum hold the video
    // would be barely longer than the two acting scenes.
    expect(report.durationSec).toBeGreaterThan(4);
  }, 300000);
});

describe('pacing', () => {
  it('still renders a correct flagship once idle compression and fades apply', async () => {
    const script = loadFlagshipOnPort(34711);
    const out = join(dir, 'paced.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(report.scenes.map((s) => s.id)).toEqual(['boot', 'order', 'logs']);
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.frames).toBe(report.frames);

    // Three scenes each keep an uncompressed tail, so however aggressively
    // idle is compressed the video cannot collapse below their sum.
    expect(report.durationSec).toBeGreaterThan(3 * SCENE_TAIL_SEC);
  }, 300000);
});

describe('failing runs produce no video', () => {
  it('does not encode when an assertion fails', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const out = join(dir, 'should-not-exist.mp4');

    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok).toBe(false);
    expect(report.frames).toBe(0);
    // The whole point: no plausible-looking artifact for a broken demo.
    expect(existsSync(out)).toBe(false);
  }, 120000);

  it('removes a stale video left by an earlier successful run', async () => {
    const { writeFileSync } = await import('node:fs');
    const out = join(dir, 'stale.mp4');
    writeFileSync(out, 'pretend this is last weeks good render');

    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    await renderDemo(script, { outputPath: out });

    expect(existsSync(out)).toBe(false);
  }, 120000);

  it('is fast, because it never reaches the encoder', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const t0 = Date.now();
    await renderDemo(script, { outputPath: join(dir, 'fast.mp4') });
    // Capture of one short scene, then stop. The baseline took 63s.
    expect(Date.now() - t0).toBeLessThan(30000);
  }, 120000);
});
