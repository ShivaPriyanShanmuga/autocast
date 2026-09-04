import { readFileSync } from 'node:fs';
import { renderDemo, formatRenderReport } from '../driver/render.js';
import { formatDiagnostics, hasErrors } from '../validate/diagnostic.js';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { lint } from '../validate/lint.js';
import type { CliIO } from './run.js';

export async function renderCommand(argv: string[], io: CliIO): Promise<number> {
  const outIndex = argv.indexOf('--out');
  const outputPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  // Skip the value that belongs to --out, but ONLY when --out is present:
  // with outIndex === -1, `outIndex + 1` is 0 and would swallow the
  // filename in the common `autocast render demo.yaml` form.
  const outValueIndex = outIndex >= 0 ? outIndex + 1 : -1;
  const file = argv.find((a, i) => !a.startsWith('--') && i !== outValueIndex);

  if (file === undefined) {
    io.err('autocast render: expects a file\n\nUsage: autocast render [--out <path>] <file>');
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    io.err(
      `autocast render: cannot read ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }

  // Never capture a script we already know is wrong.
  const parsed = parseSource(text);
  const { diagnostics, script } = checkSchema(parsed);
  const all = script ? [...diagnostics, ...lint(script, parsed)] : diagnostics;
  if (hasErrors(all) || !script) {
    io.out(formatDiagnostics(file, all));
    return 1;
  }

  try {
    const report = await renderDemo(script, outputPath ? { outputPath } : {});
    io.out(formatRenderReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    io.err(`autocast render: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
