import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, writeReport } from './report.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const scenes = [
  { id: 'boot', ok: true, assertions: [{ name: 'process_alive', ok: true }], sec: 4.02 },
  {
    id: 'order',
    ok: false,
    assertions: [{ name: 'visible', ok: false, detail: 'not visible' }],
    sec: 3.4,
  },
];

describe('buildReport', () => {
  it('puts pass/fail and assertions in the core', () => {
    const r = buildReport({
      ok: false,
      scenes,
      findings: [],
      abortedAt: 'order',
      frames: 300,
      durationSec: 10,
    });
    expect(r.core.ok).toBe(false);
    expect(r.core.scenes.map((s) => s.id)).toEqual(['boot', 'order']);
    expect(r.core.abortedAt).toBe('order');
  });

  it('keeps measured values OUT of the core', () => {
    const a = buildReport({
      ok: true,
      scenes,
      findings: [],
      abortedAt: null,
      frames: 300,
      durationSec: 10,
    });
    const b = buildReport({
      ok: true,
      scenes,
      findings: [],
      abortedAt: null,
      frames: 999,
      durationSec: 42,
    });
    // The core is what CI compares; it must not move because a run was a
    // few frames longer on a slower machine.
    expect(JSON.stringify(a.core)).toBe(JSON.stringify(b.core));
  });

  it('puts measured values in the annex', () => {
    const r = buildReport({
      ok: true,
      scenes,
      findings: [],
      abortedAt: null,
      frames: 300,
      durationSec: 10,
    });
    expect(r.measured.frames).toBe(300);
    expect(r.measured.durationSec).toBe(10);
    expect(r.measured.sceneSec.boot).toBeCloseTo(4.02, 2);
  });

  it('carries findings in the core, since they are semantic', () => {
    const r = buildReport({
      ok: false,
      scenes,
      findings: [{ code: 'H001', scene: 'boot', detail: 'an Error was printed' }],
      abortedAt: null,
      frames: 1,
      durationSec: 1,
    });
    expect(r.core.findings).toHaveLength(1);
    expect(r.core.findings[0]!.code).toBe('H001');
  });

  it('is stable across repeated builds of the same input', () => {
    const args = {
      ok: true,
      scenes,
      findings: [],
      abortedAt: null,
      frames: 1,
      durationSec: 1,
    } as const;
    expect(JSON.stringify(buildReport({ ...args }).core)).toBe(
      JSON.stringify(buildReport({ ...args }).core),
    );
  });
});

describe('writeReport', () => {
  it('writes next to the output as <name>.report.json', async () => {
    const out = join(dir, 'demo.mp4');
    const path = await writeReport(
      out,
      buildReport({
        ok: true,
        scenes,
        findings: [],
        abortedAt: null,
        frames: 1,
        durationSec: 1,
      }),
    );
    expect(path).toBe(join(dir, 'demo.report.json'));
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).core.ok).toBe(true);
  });

  it('writes even when no video was produced', async () => {
    const out = join(dir, 'nested', 'failed.mp4');
    const path = await writeReport(
      out,
      buildReport({
        ok: false,
        scenes,
        findings: [],
        abortedAt: 'order',
        frames: 0,
        durationSec: 0,
      }),
    );
    expect(existsSync(path)).toBe(true);
  });
});
