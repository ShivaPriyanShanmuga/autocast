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
