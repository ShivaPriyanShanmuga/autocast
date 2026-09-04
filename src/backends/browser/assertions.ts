import { compilePattern } from '../../schema/pattern.js';
import type { AssertResult } from '../terminal/assertions.js';
import type { BrowserSession } from './session.js';

const VISIBILITY_TIMEOUT_MS = 5000;

export async function evaluateBrowserAssertion(
  assertion: Record<string, unknown>,
  session: BrowserSession,
): Promise<AssertResult> {
  const name = Object.keys(assertion)[0] ?? '(empty)';
  const fail = (detail: string): AssertResult => ({ name, ok: false, detail });
  const pass = (): AssertResult => ({ name, ok: true });
  const { page } = session;

  if (typeof assertion.visible === 'string') {
    const selector = assertion.visible;
    try {
      await page
        .locator(selector)
        .first()
        .waitFor({ state: 'visible', timeout: VISIBILITY_TIMEOUT_MS });
      return pass();
    } catch {
      const exists = (await page.locator(selector).count()) > 0;
      return fail(
        exists ? `${selector} exists but is not visible` : `${selector} is not present on the page`,
      );
    }
  }

  if (typeof assertion.hidden === 'string') {
    const selector = assertion.hidden;
    try {
      await page
        .locator(selector)
        .first()
        .waitFor({ state: 'hidden', timeout: VISIBILITY_TIMEOUT_MS });
      return pass();
    } catch {
      return fail(`${selector} is still visible`);
    }
  }

  if (typeof assertion.text_matches === 'string') {
    const source = assertion.text_matches;
    const re = compilePattern(source);
    if (re === null) return fail(`invalid regular expression: ${source}`);
    const text = (await page.locator('body').first().innerText()) ?? '';
    return re.test(text) ? pass() : fail(`${source} did not match the page text`);
  }

  if (typeof assertion.url_matches === 'string') {
    const source = assertion.url_matches;
    const re = compilePattern(source);
    if (re === null) return fail(`invalid regular expression: ${source}`);
    const url = page.url();
    return re.test(url) ? pass() : fail(`${source} did not match the url ${url}`);
  }

  if (assertion.no_console_errors !== undefined) {
    const errors = session.consoleErrors();
    return errors.length === 0
      ? pass()
      : fail(`${errors.length} console error(s):\n${errors.slice(0, 5).join('\n')}`);
  }

  if (assertion.no_failed_requests !== undefined) {
    const failed = session.failedRequests();
    return failed.length === 0
      ? pass()
      : fail(`${failed.length} failed request(s):\n${failed.slice(0, 5).join('\n')}`);
  }

  throw new Error(
    `assertion "${name}" is terminal-only and cannot run against a browser session. ` +
      'Lint rule L009 should have caught this before capture.',
  );
}
