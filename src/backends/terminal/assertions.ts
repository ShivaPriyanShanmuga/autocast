import { compilePattern } from '../../schema/pattern.js';
import type { TerminalSession } from './session.js';

export interface AssertResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Last few non-empty lines, so a failure says what was actually on screen. */
function tail(text: string, lines = 5): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join('\n');
}

export async function evaluateAssertion(
  assertion: Record<string, unknown>,
  session: TerminalSession,
): Promise<AssertResult> {
  const name = Object.keys(assertion)[0] ?? '(empty)';
  const fail = (detail: string): AssertResult => ({ name, ok: false, detail });
  const pass = (): AssertResult => ({ name, ok: true });

  if (assertion.process_alive !== undefined) {
    const want = assertion.process_alive === true;
    const got = session.isAlive();
    return got === want ? pass() : fail(`expected process_alive=${want}, but it was ${got}`);
  }

  if (assertion.exit_code !== undefined) {
    const want = assertion.exit_code as number;
    const got = session.exitCode();
    if (got === null) return fail(`expected exit code ${want}, but the process is still running`);
    return got === want ? pass() : fail(`expected exit code ${want}, got ${got}`);
  }

  if (typeof assertion.stdout_contains === 'string') {
    const needle = assertion.stdout_contains;
    const text = await session.text();
    return text.includes(needle)
      ? pass()
      : fail(`"${needle}" not found. Last lines of output:\n${tail(text)}`);
  }

  if (typeof assertion.stdout_matches === 'string') {
    const source = assertion.stdout_matches;
    const re = compilePattern(source);
    if (re === null) return fail(`invalid regular expression: ${source}`);
    const text = await session.text();
    return re.test(text)
      ? pass()
      : fail(`${source} did not match. Last lines of output:\n${tail(text)}`);
  }

  if (assertion.stderr_empty !== undefined) {
    // A PTY is a single stream by design: the child's stdout and stderr are
    // both attached to the same terminal, so there is no separate stderr to
    // inspect. Passing here would be a false green, which spec section 8
    // exists to prevent.
    return fail(
      'stderr_empty cannot be evaluated on a terminal session: a PTY merges stdout and stderr ' +
        'onto one stream. Assert on stdout_matches instead, or run the command with `run:` and ' +
        'assert on exit_code.',
    );
  }

  throw new Error(
    `assertion "${name}" is browser-only and cannot run against a terminal session. ` +
      'Lint rule L009 should have caught this before capture.',
  );
}
