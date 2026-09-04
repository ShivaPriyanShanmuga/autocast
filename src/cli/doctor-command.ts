import { runChecks, type CheckResult } from '../doctor/checks.js';
import type { CliIO } from './run.js';

const MARK: Record<CheckResult['status'], string> = {
  ok: 'OK  ',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
};

export function formatCheckResults(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length), 0);
  const lines: string[] = ['autocast doctor', ''];

  for (const r of results) {
    lines.push(`  ${MARK[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.hint !== undefined && r.status !== 'ok') {
      lines.push('', r.hint, '');
    }
  }

  const count = (s: CheckResult['status']): number =>
    results.filter((r) => r.status === s).length;
  const failed = count('fail');
  const warned = count('warn');
  const skipped = count('skip');

  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (warned > 0) parts.push(`${warned} warning${warned === 1 ? '' : 's'}`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  lines.push('');
  if (parts.length === 0) {
    lines.push('all checks passed');
  } else if (failed === 0) {
    lines.push(`all required checks passed, ${parts.join(', ')}`);
  } else {
    lines.push(parts.join(', '));
  }

  return lines.join('\n');
}

export async function doctorCommand(_argv: string[], io: CliIO): Promise<number> {
  const results = await runChecks();
  io.out(formatCheckResults(results));
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
