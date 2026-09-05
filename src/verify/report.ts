import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Finding } from './heuristics.js';

export interface ReportSceneCore {
  id: string;
  ok: boolean;
  assertions: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface ReportCore {
  autocast: 1;
  ok: boolean;
  scenes: ReportSceneCore[];
  findings: Finding[];
  abortedAt: string | null;
}

export interface ReportMeasured {
  frames: number;
  durationSec: number;
  sceneSec: Record<string, number>;
}

export interface RenderReportFile {
  core: ReportCore;
  measured: ReportMeasured;
}

export interface BuildReportInput {
  ok: boolean;
  scenes: Array<{
    id: string;
    ok: boolean;
    assertions: Array<{ name: string; ok: boolean; detail?: string }>;
    sec: number;
  }>;
  findings: Finding[];
  abortedAt: string | null;
  frames: number;
  durationSec: number;
}

/**
 * Split the report exactly where determinism does (spec section 10).
 *
 * The core carries semantics — what passed, what failed, what the
 * heuristics found — and is byte-stable, so CI can compare it across
 * runs. Anything measured against a wall clock varies run to run and
 * belongs in the annex, or a slightly slower machine would look like a
 * regression.
 */
export function buildReport(input: BuildReportInput): RenderReportFile {
  return {
    core: {
      autocast: 1,
      ok: input.ok,
      scenes: input.scenes.map((s) => ({
        id: s.id,
        ok: s.ok,
        assertions: s.assertions.map((a) => ({
          name: a.name,
          ok: a.ok,
          ...(a.detail === undefined ? {} : { detail: a.detail }),
        })),
      })),
      findings: input.findings,
      abortedAt: input.abortedAt,
    },
    measured: {
      frames: input.frames,
      durationSec: input.durationSec,
      sceneSec: Object.fromEntries(input.scenes.map((s) => [s.id, s.sec])),
    },
  };
}

export async function writeReport(
  outputPath: string,
  report: RenderReportFile,
): Promise<string> {
  const dir = dirname(outputPath);
  const stem = basename(outputPath, extname(outputPath));
  const path = join(dir, `${stem}.report.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}
