import { describe, it, expect } from 'vitest';
import { runCli, type CliIO } from './run.js';

function captureIO() {
  const out: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: () => {} };
  return { io, out: () => out.join('\n') };
}

describe('autocast schema', () => {
  it('prints valid JSON', async () => {
    const c = captureIO();
    const code = await runCli(['schema'], c.io);
    expect(code).toBe(0);
    expect(() => JSON.parse(c.out())).not.toThrow();
  });

  it('describes the demo script shape', async () => {
    const c = captureIO();
    await runCli(['schema'], c.io);
    const schema = JSON.parse(c.out()) as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['autocast', 'output', 'sessions', 'scenes']),
    );
  });
});
