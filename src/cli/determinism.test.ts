import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { renderDemo, formatRenderReport } from '../driver/render.js';

const dir = mkdtempSync(join(tmpdir(), 'autodemo-det-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function load(path: string) {
  const { script } = checkSchema(parseSource(readFileSync(path, 'utf8')));
  if (!script) throw new Error('fixture invalid');
  return script;
}

const coreOf = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')).core as Record<string, unknown>;

describe('determinism', () => {
  it('produces an identical report core across two runs', async () => {
    const script = load('fixtures/terminal/demo.yaml');

    const a = await renderDemo(script, { outputPath: join(dir, 'one.mp4') });
    const b = await renderDemo(script, { outputPath: join(dir, 'two.mp4') });

    // Semantics must be identical; wall-clock measurements need not be.
    // This is the whole reason the report is split (spec section 10).
    expect(JSON.stringify(coreOf(join(dir, 'one.report.json')))).toBe(
      JSON.stringify(coreOf(join(dir, 'two.report.json'))),
    );
    expect(a.ok).toBe(b.ok);
  }, 300000);

  it('keeps measured values out of the compared core', () => {
    const raw = JSON.parse(readFileSync(join(dir, 'one.report.json'), 'utf8'));
    expect(typeof raw.measured.durationSec).toBe('number');
    expect(typeof raw.measured.frames).toBe('number');
    // A duration appearing in the core would make every slower machine
    // look like a regression.
    expect(JSON.stringify(raw.core)).not.toContain('durationSec');
    expect(JSON.stringify(raw.core)).not.toContain('"frames"');
  });
});

describe('token budget', () => {
  it('keeps the report flat in video length', async () => {
    const short = load('fixtures/terminal/demo.yaml');
    const long = load('fixtures/terminal/demo.yaml');
    // Same scene count, much longer video.
    long.defaults = { ...long.defaults, settle: '2s' };

    const a = await renderDemo(short, { outputPath: join(dir, 'short.mp4') });
    const b = await renderDemo(long, { outputPath: join(dir, 'long.mp4') });

    expect(b.durationSec).toBeGreaterThan(a.durationSec);

    // Report size tracks scene count, never duration (spec section 9).
    // Both reports name the same scenes and assertions, so the only
    // difference is a couple of digits in the frame and second counts.
    const textA = formatRenderReport(a).length;
    const textB = formatRenderReport(b).length;
    expect(Math.abs(textA - textB)).toBeLessThan(80);
  }, 400000);
});
