import { runChecks, type CheckResult } from '../doctor/checks.js';
import type { CliIO } from './run.js';

const MARK: Record<CheckResult['status'], string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };

export function formatCheckResults(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length), 0);
  const lines: string[] = ['autocast doctor', ''];

  for (const r of results) {
    lines.push(`  ${MARK[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.hint !== undefined && r.status !== 'ok') {
      lines.push('', r.hint, '');
    }
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  lines.push('');
  if (failed > 0) {
    lines.push(`${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}`);
  } else if (warned > 0) {
    lines.push(`all required checks passed, ${warned} warning${warned === 1 ? '' : 's'}`);
  } else {
    lines.push('all checks passed');
  }

  return lines.join('\n');
}

export async function doctorCommand(_argv: string[], io: CliIO): Promise<number> {
  const results = await runChecks();
  io.out(formatCheckResults(results));
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
