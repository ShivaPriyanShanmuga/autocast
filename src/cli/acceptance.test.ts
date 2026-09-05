import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('Phase 0 exit criteria', () => {
  it('doctor reports every check with a status', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    for (const name of ['ffmpeg', 'libx264', 'librubberband', 'cwd writable']) {
      expect(c.out()).toContain(name);
    }
  });

  it('doctor gives an actionable hint for anything not OK', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    const text = c.out();
    if (text.includes('FAIL') || text.includes('WARN')) {
      expect(text).toMatch(/install|unavailable|writes/i);
    }
  });

  it('validate passes the flagship fixture', async () => {
    const c = captureIO();
    expect(await runCli(['validate', 'fixtures/mixed/demo.yaml'], c.io)).toBe(0);
  });

  it('validate fails a broken fixture, naming the line and the reason', async () => {
    const c = captureIO();
    const code = await runCli(['validate', 'fixtures/broken/undeclared-session.yaml'], c.io);
    expect(code).toBe(1);
    expect(c.out()).toMatch(/undeclared-session\.yaml:\d+:\d+/);
    expect(c.out()).toContain('not declared');
  });

  it('every broken fixture is rejected', async () => {
    for (const f of ['undeclared-session', 'bad-regex', 'wrong-backend', 'yaml-syntax']) {
      const c = captureIO();
      const code = await runCli(['validate', `fixtures/broken/${f}.yaml`], c.io);
      expect(code, `fixtures/broken/${f}.yaml should fail`).toBe(1);
    }
  });

  it('carries no dependency beyond the declared set', () => {
    // A new entry here means scope crept; add it deliberately, not by accident.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@fontsource/jetbrains-mono',
      '@napi-rs/canvas',
      '@xterm/headless',
      'node-pty',
      'playwright',
      'yaml',
      'zod',
    ]);
  });
});

describe('Phase 1 exit criteria', () => {
  it('renders a real command to a playable mp4', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { probeVideo } = await import('../render/encoder.js');

    const dir = mkdtempSync(join(tmpdir(), 'autocast-accept-'));
    try {
      const out = join(dir, 'phase1.mp4');
      const c = captureIO();
      const code = await runCli(['render', 'fixtures/terminal/demo.yaml', '--out', out], c.io);

      expect(code, c.out() + c.err()).toBe(0);
      expect(existsSync(out)).toBe(true);

      const probe = await probeVideo(out);
      expect(probe.codec).toBe('h264');
      expect(probe.frames).toBeGreaterThan(60); // more than 2 seconds at 30fps
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 240000);
});

describe('Phase 2a exit criteria', () => {
  it('validates the browser fixture', async () => {
    const c = captureIO();
    expect(await runCli(['validate', 'fixtures/browser/demo.yaml'], c.io)).toBe(0);
  });

  it('doctor reports chromium', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    expect(c.out()).toContain('chromium');
  }, 60000);
});

describe('Phase 2 exit criteria', () => {
  const PORT = 34602;
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

  it('renders a real web app to a playable mp4', async () => {
    const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { probeVideo } = await import('../render/encoder.js');

    const dir = mkdtempSync(join(tmpdir(), 'autocast-p2-'));
    try {
      const yaml = readFileSync('fixtures/browser/demo.yaml', 'utf8').replace(
        /127\.0\.0\.1:\d+/,
        `127.0.0.1:${PORT}`,
      );
      const script = join(dir, 'demo.yaml');
      writeFileSync(script, yaml);

      const out = join(dir, 'phase2.mp4');
      const c = captureIO();
      const code = await runCli(['render', script, '--out', out], c.io);

      expect(code, c.out() + c.err()).toBe(0);
      expect(existsSync(out)).toBe(true);

      const probe = await probeVideo(out);
      expect(probe.codec).toBe('h264');
      expect(probe.frames).toBeGreaterThan(60);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 300000);
});

describe('Phase 3 exit criteria', () => {
  it('renders terminal, browser and inset as one continuous artifact', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { probeVideo } = await import('../render/encoder.js');

    const dir = mkdtempSync(join(tmpdir(), 'autocast-p3-'));
    try {
      const out = join(dir, 'flagship.mp4');
      const c = captureIO();
      const code = await runCli(['render', 'fixtures/flagship/demo.yaml', '--out', out], c.io);

      expect(code, c.out() + c.err()).toBe(0);
      expect(existsSync(out)).toBe(true);

      const probe = await probeVideo(out);
      // One canvas throughout: the ABSENCE of a resolution change is the
      // exit criterion.
      expect(probe.width).toBe(1280);
      expect(probe.height).toBe(720);
      expect(probe.codec).toBe('h264');
      expect(probe.frames).toBeGreaterThan(90);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 300000);
});
