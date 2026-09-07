import { describe, it, expect } from 'vitest';
import { DemoScript } from './demo.js';

const minimal = {
  autocast: 1,
  output: { path: 'docs/demo.mp4' },
  sessions: { api: { backend: 'terminal' } },
  scenes: [{ id: 'boot', use: 'api', steps: [{ type: 'ls' }] }],
};

describe('DemoScript', () => {
  it('accepts a minimal valid script', () => {
    const r = DemoScript.safeParse(minimal);
    expect(r.success).toBe(true);
  });

  it('defaults canvas and fps', () => {
    const r = DemoScript.safeParse(minimal);
    expect(r.success && r.data.output.canvas).toEqual([1280, 720]);
    expect(r.success && r.data.output.fps).toBe(30);
  });

  it('rejects a wrong version literal', () => {
    const r = DemoScript.safeParse({ ...minimal, autocast: 2 });
    expect(r.success).toBe(false);
  });

  it('rejects a step with two action keys', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      scenes: [{ id: 'a', use: 'api', steps: [{ type: 'ls', goto: 'http://x' }] }],
    });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toContain('exactly one action key');
  });

  it('rejects a step with an unknown key', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      scenes: [{ id: 'a', use: 'api', steps: [{ frobnicate: 'ls' }] }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an uncompilable regex in wait_for.stdout', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      scenes: [{ id: 'a', use: 'api', steps: [{ wait_for: { stdout: '/oops(/' } }] }],
    });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toContain('regular expression');
  });

  it('rejects a duration that is not a number or ms/s string', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      defaults: { settle: '400 milliseconds' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts a browser session with a cdp attach target', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      sessions: { app: { backend: 'browser', attach: { cdp: 'http://localhost:9222' } } },
      scenes: [{ id: 'a', use: 'app', steps: [{ goto: 'http://x' }] }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts an optional style block', () => {
    const r = DemoScript.safeParse({
      ...minimal,
      style: {
        background: { gradient: ['#1a1a2e', '#16213e'], padding: 64 },
        window: { radius: 12, shadow: true },
        zoom: { auto: true, on: 'click', scale: 1.8, ease: 'spring' },
        cursor: { size: 1.5 },
        motion_blur: { cursor: true, zoom: true, pan: true },
      },
    });
    expect(r.success).toBe(true);
  });
});

describe('caption fields', () => {
  const base = {
    autocast: 1,
    output: { path: 'a.mp4', canvas: [1280, 720] },
    sessions: { api: { backend: 'terminal' } },
    scenes: [{ id: 's', use: 'api', narrate: 'hello' }],
  };

  it('accepts style.captions', () => {
    expect(DemoScript.safeParse({ ...base, style: { captions: false } }).success).toBe(true);
    expect(DemoScript.safeParse({ ...base, style: { captions: true } }).success).toBe(true);
  });

  it('accepts defaults.speech_rate', () => {
    expect(DemoScript.safeParse({ ...base, defaults: { speech_rate: 120 } }).success).toBe(true);
  });

  it('leaves both optional', () => {
    expect(DemoScript.safeParse(base).success).toBe(true);
  });

  it('rejects a speech rate that would make a scene infinitely long', () => {
    for (const speech_rate of [0, -30]) {
      expect(DemoScript.safeParse({ ...base, defaults: { speech_rate } }).success).toBe(false);
    }
  });

  it('still rejects unknown keys', () => {
    expect(DemoScript.safeParse({ ...base, style: { captoins: true } }).success).toBe(false);
    expect(DemoScript.safeParse({ ...base, defaults: { speach_rate: 120 } }).success).toBe(false);
  });
});

describe('voice block', () => {
  const base = {
    autocast: 1,
    output: { path: 'a.mp4', canvas: [1280, 720] },
    sessions: { api: { backend: 'terminal' } },
    scenes: [{ id: 's', use: 'api', narrate: 'hello' }],
  };

  it('parses a full voice block', () => {
    const r = DemoScript.safeParse({
      ...base,
      voice: { enabled: true, backend: 'kokoro', voice: 'af_heart', rate: 1.05, sync: 'strict' },
    });
    expect(r.success).toBe(true);
  });

  it('is optional', () => {
    expect(DemoScript.safeParse(base).success).toBe(true);
  });

  it('rejects a non-positive rate', () => {
    expect(DemoScript.safeParse({ ...base, voice: { rate: 0 } }).success).toBe(false);
  });

  it('rejects an unknown backend or sync mode', () => {
    expect(DemoScript.safeParse({ ...base, voice: { backend: 'elevenlabs' } }).success).toBe(false);
    expect(DemoScript.safeParse({ ...base, voice: { sync: 'loose' } }).success).toBe(false);
  });

  it('still rejects unknown keys', () => {
    expect(DemoScript.safeParse({ ...base, voice: { enbaled: true } }).success).toBe(false);
  });
});
