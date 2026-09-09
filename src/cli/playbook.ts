import type { RenderReport } from '../driver/render.js';

/**
 * One concrete thing to do next.
 *
 * The report already says what broke. What an agent lacks is what to DO
 * about it, and guessing costs a whole render — the expensive operation
 * in the loop (spec section 9). Keeping this to a single line keeps the
 * per-iteration budget where section 9 claims it is.
 */
export function nextStepFor(report: RenderReport): string | null {
  if (report.ok) return null;

  const sync = report.findings.find((f) => f.code === 'H005');
  if (sync) {
    return (
      `next: scene "${sync.scene}" is being held open to finish its narration. ` +
      'Shorten `narrate:`, or set `voice.sync: hold` to accept the slower pacing.'
    );
  }

  const scene = report.scenes.find((s) => !s.ok);
  const failed = scene?.assertions.find((a) => !a.ok);
  const where = scene ? `scene "${scene.id}"` : 'the failing scene';

  if (!failed) {
    return `next: read ${report.reportPath} — the scenes ran but the render did not complete.`;
  }

  const detail = failed.detail ?? '';

  if (failed.name === 'focus') {
    return (
      `next: the \`focus:\` in ${where} matched nothing when the scene ended. ` +
      'Point it at an element the steps have already revealed, or drop it and let ' +
      '`style.zoom.auto` frame the last click.'
    );
  }

  if (failed.name === 'wait_for' || /timed out/i.test(detail)) {
    return (
      `next: a wait in ${where} timed out. Check the pattern against what the ` +
      `session actually printed — ${report.reportPath} records it — and widen it, ` +
      'or raise the timeout if the step is genuinely slow.'
    );
  }

  if (/matched no|not visible|no element/i.test(detail)) {
    return (
      `next: a selector in ${where} matched nothing. Add a \`wait_for\` before the ` +
      'step that uses it — the element probably had not rendered yet.'
    );
  }

  if (failed.name === 'no_console_errors' || /console/i.test(detail)) {
    return (
      `next: the page logged a console error in ${where}. Fix it in the app, or ` +
      'drop the `no_console_errors` assertion if it is expected.'
    );
  }

  return `next: assertion "${failed.name}" failed in ${where}. See ${report.reportPath}.`;
}

/**
 * Environment failures that `castscript doctor` already diagnoses.
 *
 * A cold install fails inside Playwright, ffmpeg or node-pty, and those
 * libraries report in their own words — Playwright prints an ASCII box
 * about downloading browsers. None of them know that castscript has a
 * command which names the exact problem and the exact fix, so the render
 * has to say so itself.
 */
export function environmentHint(message: string): string | null {
  const m = message.toLowerCase();

  const missingBrowser =
    m.includes('playwright install') ||
    (m.includes('browsertype.launch') && m.includes("executable doesn't exist"));
  if (missingBrowser) {
    return (
      'The browser binary is missing. Install it, then render again:\n' +
      '  npx playwright install chromium\n' +
      '  castscript doctor          (confirms every dependency at once)'
    );
  }

  if (m.includes('could not run ffmpeg') || m.includes('spawn ffmpeg')) {
    return (
      'ffmpeg is not on PATH, so there is nothing to encode with.\n' +
      '  castscript doctor          (prints the install command for your OS)'
    );
  }

  if (m.includes('could not start a terminal') || m.includes('posix_spawnp')) {
    return (
      'A terminal session could not be started.\n' +
      '  castscript doctor          (reports the shell it tried and why it failed)'
    );
  }

  // Anything else is the script's problem, not the machine's. Sending an
  // author to `doctor` for a selector that does not match is a wrong turn.
  return null;
}
