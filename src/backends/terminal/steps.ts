import { compilePattern } from '../../schema/pattern.js';
import { planTyping } from './typing.js';
import type { TerminalSession } from './session.js';

export interface StepResult {
  ok: boolean;
  startedAt: number;
  endedAt: number;
  detail?: string;
}

export interface StepContext {
  session: TerminalSession;
  /** Seeds typing jitter; use the scene id so re-renders match. */
  seed: string;
  typingSpeedMs: number;
  settleMs: number;
  now: () => number;
}

/** Names accepted by a `key:` step, mapped to the bytes a PTY expects. */
const KEYS: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Space: ' ',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  CtrlC: '\x03',
  CtrlD: '\x04',
};

const DEFAULT_WAIT_MS = 30000;

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  const value = Number(m[1]);
  return m[2] === 's' ? value * 1000 : value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A step is one object with exactly one action key; the schema guarantees it. */
type AnyStep = Record<string, unknown>;

export async function executeStep(step: AnyStep, ctx: StepContext): Promise<StepResult> {
  const startedAt = ctx.now();
  const done = (ok: boolean, detail?: string): StepResult => ({
    ok,
    startedAt,
    endedAt: ctx.now(),
    ...(detail === undefined ? {} : { detail }),
  });

  if (typeof step.type === 'string') {
    for (const stroke of planTyping(step.type, { seed: ctx.seed, baseMs: ctx.typingSpeedMs })) {
      ctx.session.write(stroke.char);
      await sleep(stroke.delayMs);
    }
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (typeof step.key === 'string') {
    const bytes = KEYS[step.key];
    if (bytes === undefined) {
      return done(false, `unknown key "${step.key}". Known keys: ${Object.keys(KEYS).join(', ')}`);
    }
    ctx.session.write(bytes);
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (step.wait_for !== undefined) {
    const w = step.wait_for as { stdout?: string; selector?: string; timeout?: number | string };
    if (w.selector !== undefined) {
      throw new Error('wait_for.selector is browser-only; lint rule L008 should have caught this');
    }
    if (w.stdout === undefined) {
      return done(false, 'wait_for on a terminal session needs a stdout pattern');
    }
    const re = compilePattern(w.stdout);
    if (re === null) return done(false, `invalid regular expression: ${w.stdout}`);

    const timeout = toMs(w.timeout, DEFAULT_WAIT_MS);
    const matched = await ctx.session.waitFor(re, timeout);
    return matched
      ? done(true)
      : done(false, `timed out after ${timeout}ms waiting for ${w.stdout} on stdout`);
  }

  if (typeof step.run === 'string') {
    const marker = `__castscript_done_${Math.random().toString(36).slice(2, 8)}__`;
    const joiner = process.platform === 'win32' ? ' & ' : ' ; ';
    ctx.session.write(`${step.run}${joiner}echo ${marker}\r`);
    // The shell echoes the command line before running it, so the marker
    // appears twice: once in the echo of what we typed, once as real
    // output. The second occurrence is what proves the command finished.
    //
    // We cannot match that with a RegExp over the rendered text: a command
    // line longer than the terminal is wrapped, and wrapping inserts a
    // newline mid-token, so a marker can be split in half. Stripping all
    // whitespace first rejoins it.
    const countMarkers = (text: string): number =>
      text.replace(/\s+/g, '').split(marker).length - 1;
    const matched = await ctx.session.waitUntil(
      (text) => countMarkers(text) >= 2,
      DEFAULT_WAIT_MS,
    );
    await sleep(ctx.settleMs);
    return matched ? done(true) : done(false, `run did not complete: ${step.run}`);
  }

  if (step.sleep !== undefined) {
    await sleep(toMs(step.sleep as number | string, 0));
    return done(true);
  }

  const key = Object.keys(step)[0] ?? '(empty)';
  throw new Error(
    `step "${key}" is not supported by the terminal backend — it is browser-only. ` +
      'Lint rule L008 should have caught this before capture.',
  );
}
