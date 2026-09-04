import { planTyping } from '../terminal/typing.js';
import type { StepResult } from '../terminal/steps.js';
import type { BrowserSession } from './session.js';

export interface BrowserStepContext {
  session: BrowserSession;
  settleMs: number;
  now: () => number;
  /** Per-character delay for `fill`, matching the terminal backend. */
  typingSpeedMs?: number;
  /** Seeds typing jitter; use the scene id so re-renders match. */
  seed?: string;
  /**
   * How long a click or fill waits for its target. Configurable so tests
   * and fast-failing runs need not sit through the full default.
   */
  actionTimeoutMs?: number;
}

const DEFAULT_WAIT_MS = 30000;

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Record where the cursor should be for this action, before acting. */
async function recordTarget(
  ctx: BrowserStepContext,
  selector: string,
  click: boolean,
): Promise<void> {
  const box = await ctx.session.boundingBox(selector);
  if (box) {
    ctx.session.recordPointer({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, click);
  }
}

const message = (e: unknown): string =>
  e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);

export async function executeBrowserStep(
  step: Record<string, unknown>,
  ctx: BrowserStepContext,
): Promise<StepResult> {
  const startedAt = ctx.now();
  const done = (ok: boolean, detail?: string): StepResult => ({
    ok,
    startedAt,
    endedAt: ctx.now(),
    ...(detail === undefined ? {} : { detail }),
  });
  const { page } = ctx.session;
  const actionTimeout = ctx.actionTimeoutMs ?? DEFAULT_WAIT_MS;

  if (typeof step.goto === 'string') {
    try {
      await ctx.session.goto(step.goto);
      await sleep(ctx.settleMs);
      return done(true);
    } catch (e) {
      return done(false, `could not load ${step.goto}: ${message(e)}`);
    }
  }

  if (typeof step.click === 'string') {
    const selector = step.click;
    await recordTarget(ctx, selector, true);
    try {
      await page.locator(selector).first().click({ timeout: actionTimeout });
      await sleep(ctx.settleMs);
      return done(true);
    } catch (e) {
      return done(false, `could not click ${selector}: ${message(e)}`);
    }
  }

  if (step.fill !== undefined) {
    const f = step.fill as { selector: string; value: string };
    await recordTarget(ctx, f.selector, false);
    try {
      const field = page.locator(f.selector).first();
      // Clear, then type character by character with the same humanised
      // rhythm the terminal backend uses. fill() sets the value in one
      // shot, which on screen reads as the text teleporting in.
      await field.fill('', { timeout: actionTimeout });
      await field.focus({ timeout: actionTimeout });
      for (const stroke of planTyping(f.value, {
        seed: ctx.seed ?? f.selector,
        baseMs: ctx.typingSpeedMs ?? 65,
      })) {
        await page.keyboard.type(stroke.char);
        await sleep(stroke.delayMs);
      }
      await sleep(ctx.settleMs);
      return done(true);
    } catch (e) {
      return done(false, `could not fill ${f.selector}: ${message(e)}`);
    }
  }

  if (typeof step.type === 'string') {
    await page.keyboard.type(step.type);
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (typeof step.key === 'string') {
    await page.keyboard.press(step.key);
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (step.wait_for !== undefined) {
    const w = step.wait_for as {
      selector?: string;
      stdout?: string;
      timeout?: number | string;
    };
    if (w.stdout !== undefined) {
      throw new Error('wait_for.stdout is terminal-only; lint rule L008 should have caught this');
    }
    if (w.selector === undefined) {
      return done(false, 'wait_for on a browser session needs a selector');
    }
    const timeout = toMs(w.timeout, DEFAULT_WAIT_MS);
    try {
      await page.locator(w.selector).first().waitFor({ state: 'visible', timeout });
      return done(true);
    } catch {
      return done(false, `timed out after ${timeout}ms waiting for ${w.selector} to be visible`);
    }
  }

  if (step.sleep !== undefined) {
    await sleep(toMs(step.sleep as number | string, 0));
    return done(true);
  }

  const key = Object.keys(step)[0] ?? '(empty)';
  throw new Error(
    `step "${key}" is not supported by the browser backend — it is terminal-only. ` +
      'Lint rule L008 should have caught this before capture.',
  );
}
