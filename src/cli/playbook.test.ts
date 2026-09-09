import { describe, it, expect } from 'vitest';
import { nextStepFor, environmentHint } from './playbook.js';
import type { RenderReport } from '../driver/render.js';

const report = (over: Partial<RenderReport> = {}): RenderReport => ({
  ok: false,
  outputPath: 'docs/demo.mp4',
  contactSheetPath: null,
  findings: [],
  reportPath: 'docs/demo.report.json',
  scenes: [],
  frames: 0,
  durationSec: 0,
  ...over,
});

const failing = (name: string, detail: string): RenderReport =>
  report({
    scenes: [{ id: 'order', ok: false, assertions: [{ name, ok: false, detail }] }],
  });

describe('nextStepFor', () => {
  it('says nothing when the render worked', () => {
    expect(nextStepFor(report({ ok: true, frames: 100 }))).toBeNull();
  });

  it('tells an agent to wait when a selector matched nothing', () => {
    // Guessing costs a whole render, which is the expensive operation in
    // the loop. One concrete next action is worth more than a diagnosis.
    const step = nextStepFor(failing('visible', 'selector .order-confirmed matched no element'));
    expect(step).toMatch(/wait_for/);
    expect(step).toMatch(/order/);
  });

  it('tells an agent to check the pattern when a wait timed out', () => {
    const step = nextStepFor(failing('wait_for', 'timed out after 15000ms waiting for /ready/'));
    expect(step).toMatch(/pattern/i);
  });

  it('suggests loosening a focus that framed nothing', () => {
    const step = nextStepFor(failing('focus', 'focus selector #submit matched no visible element'));
    expect(step).toMatch(/focus/);
  });

  it('acts on a sync finding even though every assertion passed', () => {
    // H005 is not an assertion failure; the demo is "correct" and still
    // paced wrong, which is exactly the case a human would miss.
    const step = nextStepFor(
      report({
        ok: false,
        findings: [{ code: 'H005', scene: 'proof', detail: 'held open to finish the sentence' }],
      }),
    );
    expect(step).toMatch(/narration/i);
    expect(step).toMatch(/sync/);
  });

  it('mentions the console when a page logged errors', () => {
    const step = nextStepFor(failing('no_console_errors', 'console error: ReferenceError x'));
    expect(step).toMatch(/console/i);
  });

  it('falls back to something useful for an unrecognised failure', () => {
    const step = nextStepFor(failing('mystery', 'something we have never seen'));
    expect(step).not.toBeNull();
    expect(step).toMatch(/report/);
  });

  it('stays short enough not to bloat the report', () => {
    // Section 9 budgets roughly 300 tokens per iteration. A playbook
    // that blew that would undo the reason the loop is cheap.
    for (const name of ['visible', 'wait_for', 'focus', 'no_console_errors', 'mystery']) {
      const step = nextStepFor(failing(name, 'detail here')) ?? '';
      expect(step.length).toBeLessThan(400);
    }
  });
});

describe('environmentHint', () => {
  it('points a missing browser at doctor', () => {
    // What a cold install actually produces: Playwright's own ASCII box,
    // which says nothing about castscript having a command that
    // diagnoses exactly this.
    const hint = environmentHint(
      "browserType.launch: Executable doesn't exist at C:\...\chrome-headless-shell.exe\n" +
        'Please run the following command to download new browsers:\n' +
        '    npx playwright install',
    );
    expect(hint).toMatch(/castscript doctor/);
    expect(hint).toMatch(/playwright install/);
  });

  it('points a missing ffmpeg at doctor', () => {
    expect(environmentHint('could not run ffmpeg: spawn ffmpeg ENOENT')).toMatch(
      /castscript doctor/,
    );
  });

  it('points a terminal that will not start at doctor', () => {
    expect(environmentHint('could not start a terminal: posix_spawnp failed.')).toMatch(
      /castscript doctor/,
    );
  });

  it('says nothing about an ordinary script error', () => {
    // A selector that does not match is the author's problem, not the
    // environment's; sending them to doctor would be a wrong turn.
    expect(environmentHint('locator.click: Timeout 5000ms exceeded')).toBeNull();
    expect(environmentHint('scene "boot" uses session "api", which is not declared')).toBeNull();
  });
});
