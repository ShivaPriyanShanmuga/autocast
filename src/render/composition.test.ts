import { describe, it, expect } from 'vitest';
import type { DemoScript } from '../schema/demo.js';
import type { SceneCapture } from '../driver/capture.js';
import {
  planComposition,
  wallClockAt,
  MIN_SCENE_SEC,
  SCENE_TAIL_SEC,
  SCENE_HEAD_SEC,
} from './composition.js';

const script = {
  autocast: 1,
  output: { path: 'x.mp4', canvas: [1280, 720], fps: 30 },
  sessions: {
    api: { backend: 'terminal' },
    web: { backend: 'browser' },
  },
  scenes: [
    { id: 'boot', use: 'api' },
    { id: 'order', use: 'web' },
    {
      id: 'logs',
      use: 'api',
      layout: { primary: 'web', inset: { session: 'api', corner: 'bottom-right', scale: 0.4 } },
    },
  ],
} as unknown as DemoScript;

const scene = (id: string, startedAt: number, endedAt: number): SceneCapture => ({
  id,
  steps: [],
  assertions: [],
  ok: true,
  startedAt,
  endedAt,
});

const BASE = 1788570640000;
const captures = [
  scene('boot', BASE, BASE + 3100),
  scene('order', BASE + 3100, BASE + 5120),
  scene('logs', BASE + 5120, BASE + 5120), // zero duration, as the spike found
];

describe('planComposition', () => {
  it('lays scenes end to end with no gaps', () => {
    const plan = planComposition(script, captures);
    expect(plan.windows.map((w) => w.id)).toEqual(['boot', 'order', 'logs']);
    for (let i = 1; i < plan.windows.length; i++) {
      expect(plan.windows[i]!.outStartSec).toBeCloseTo(plan.windows[i - 1]!.outEndSec, 6);
    }
    expect(plan.windows[0]!.outStartSec).toBe(0);
  });

  it('uses the measured duration plus a tail beat', () => {
    const plan = planComposition(script, captures);
    const boot = plan.windows[0]!;
    expect(boot.outEndSec - boot.outStartSec).toBeCloseTo(3.1 + SCENE_TAIL_SEC, 3);
  });

  it('gives a zero-duration scene a minimum hold instead of one frame', () => {
    const plan = planComposition(script, captures);
    const logs = plan.windows[2]!;
    // `logs` is not the first scene, so it also carries a head.
    expect(logs.outEndSec - logs.outStartSec).toBeCloseTo(
      SCENE_HEAD_SEC + MIN_SCENE_SEC + SCENE_TAIL_SEC,
      3,
    );
  });

  it('honours an overridden minimum', () => {
    const plan = planComposition(script, captures, {
      minSceneSec: 3,
      sceneTailSec: 0,
      sceneHeadSec: 0,
    });
    const logs = plan.windows[2]!;
    expect(logs.outEndSec - logs.outStartSec).toBeCloseTo(3, 3);
  });

  it('adds a tail beat to every scene so its result can be read', () => {
    // wait_for returns the INSTANT its pattern matches, so without a tail
    // the scene cuts on the very frame the output appears.
    const withTail = planComposition(script, captures);
    const without = planComposition(script, captures, { sceneTailSec: 0 });
    for (let i = 0; i < withTail.windows.length; i++) {
      const a = withTail.windows[i]!;
      const b = without.windows[i]!;
      expect(a.outEndSec - a.outStartSec).toBeCloseTo(
        b.outEndSec - b.outStartSec + SCENE_TAIL_SEC,
        3,
      );
    }
  });

  it('holds the scene end state through the tail rather than cutting', () => {
    const plan = planComposition(script, captures);
    const boot = plan.windows[0]!;
    // Just before the cut, we must still be in `boot` showing its last
    // captured moment — not already in the next scene.
    const atCut = wallClockAt(plan, boot.outEndSec - 0.02)!;
    expect(atCut.window.id).toBe('boot');
    expect(atCut.wallMs).toBeCloseTo(BASE + 3100, 0);
  });

  it('reports a total equal to the last window end', () => {
    const plan = planComposition(script, captures);
    expect(plan.totalSec).toBeCloseTo(plan.windows[2]!.outEndSec, 6);
  });

  it('defaults primary to the scene session and inset to null', () => {
    const plan = planComposition(script, captures);
    expect(plan.windows[0]!.primary).toBe('api');
    expect(plan.windows[0]!.inset).toBeNull();
  });

  it('reads primary and inset from an explicit layout', () => {
    const plan = planComposition(script, captures);
    const logs = plan.windows[2]!;
    expect(logs.primary).toBe('web');
    expect(logs.inset).toEqual({ session: 'api', corner: 'bottom-right', scale: 0.4 });
  });

  it('throws when a scene references an unknown session', () => {
    const bad = { ...script, scenes: [{ id: 'x', use: 'ghost' }] } as unknown as DemoScript;
    expect(() => planComposition(bad, [scene('x', BASE, BASE + 100)])).toThrow(/ghost/);
  });
});

describe('wallClockAt', () => {
  const plan = planComposition(script, captures);

  it('returns null outside the timeline', () => {
    expect(wallClockAt(plan, -1)).toBeNull();
    expect(wallClockAt(plan, plan.totalSec + 5)).toBeNull();
  });

  it('maps the start of the timeline to the first scene start', () => {
    const r = wallClockAt(plan, 0)!;
    expect(r.window.id).toBe('boot');
    expect(r.wallMs).toBeCloseTo(BASE, 0);
  });

  it('advances wall time 1:1 inside a scene', () => {
    const r = wallClockAt(plan, 1.0)!;
    expect(r.window.id).toBe('boot');
    expect(r.wallMs).toBeCloseTo(BASE + 1000, 0);
  });

  it('selects the right scene for a later time', () => {
    // Relative to the plan, not a fixed second: the pacing constants are
    // tuning knobs and a test that pins them tests nothing useful.
    const r = wallClockAt(plan, plan.windows[1]!.outStartSec + 0.1)!;
    expect(r.window.id).toBe('order');
  });

  it('freezes wall time during a hold rather than inventing time', () => {
    const logs = plan.windows[2]!;
    const early = wallClockAt(plan, logs.outStartSec + 0.05)!;
    const late = wallClockAt(plan, logs.outEndSec - 0.05)!;
    expect(early.window.id).toBe('logs');
    expect(late.window.id).toBe('logs');
    // Zero measured duration, so wall time cannot advance at all.
    expect(late.wallMs).toBeCloseTo(early.wallMs, 0);
    expect(late.wallMs).toBeCloseTo(BASE + 5120, 0);
  });

  it('never runs wall time past a scene end', () => {
    const boot = plan.windows[0]!;
    const r = wallClockAt(plan, boot.outEndSec - 0.001)!;
    expect(r.wallMs).toBeLessThanOrEqual(BASE + 3100 + 1);
  });
});

describe('idle compression', () => {
  // `boot` measured 3.1s; say 2s of that was dead air.
  const idleByScene = {
    boot: [{ startMs: BASE + 500, endMs: BASE + 2500 }],
  };

  it('shortens a scene containing idle', () => {
    const plain = planComposition(script, captures);
    const compressed = planComposition(script, captures, { idleByScene });
    const a = plain.windows[0]!;
    const b = compressed.windows[0]!;
    expect(b.outEndSec - b.outStartSec).toBeLessThan(a.outEndSec - a.outStartSec);
  });

  it('caps how much an idle span is sped up', () => {
    const compressed = planComposition(script, captures, { idleByScene, maxSpeedup: 4 });
    const boot = compressed.windows[0]!;
    // 1.1s active + 2s/4 idle, floored at the minimum body, plus the tail.
    expect(boot.outEndSec - boot.outStartSec).toBeCloseTo(
      Math.max(1.1 + 0.5, MIN_SCENE_SEC) + SCENE_TAIL_SEC,
      2,
    );
  });

  it('leaves the tail uncompressed', () => {
    const aggressive = planComposition(script, captures, {
      idleByScene: { boot: [{ startMs: BASE, endMs: BASE + 3100 }] },
      maxSpeedup: 100,
    });
    const boot = aggressive.windows[0]!;
    expect(boot.outEndSec - boot.outStartSec).toBeGreaterThanOrEqual(SCENE_TAIL_SEC);
  });

  it('does not touch scenes with no idle recorded', () => {
    const plain = planComposition(script, captures);
    const compressed = planComposition(script, captures, { idleByScene });
    const a = plain.windows[1]!;
    const b = compressed.windows[1]!;
    expect(b.outEndSec - b.outStartSec).toBeCloseTo(a.outEndSec - a.outStartSec, 6);
  });

  it('keeps the output-to-wall mapping monotonic', () => {
    const plan = planComposition(script, captures, { idleByScene });
    let previous = -Infinity;
    for (let t = 0; t < plan.totalSec; t += 1 / 30) {
      const at = wallClockAt(plan, t);
      if (!at || at.window.id !== 'boot') continue;
      // A backwards step would make CastPlayer throw.
      expect(at.wallMs).toBeGreaterThanOrEqual(previous);
      previous = at.wallMs;
    }
  });

  it('still reaches the end of the captured span', () => {
    const plan = planComposition(script, captures, { idleByScene });
    const boot = plan.windows[0]!;
    const atEnd = wallClockAt(plan, boot.outEndSec - 0.01)!;
    expect(atEnd.wallMs).toBeCloseTo(BASE + 3100, 0);
  });

  it('passes through idle time faster than active time', () => {
    const plan = planComposition(script, captures, { idleByScene, maxSpeedup: 8 });
    const boot = plan.windows[0]!;
    const early = wallClockAt(plan, boot.outStartSec + 0.1)!;
    const later = wallClockAt(plan, boot.outStartSec + 0.2)!;
    const activeRate = later.wallMs - early.wallMs;

    const midA = wallClockAt(plan, boot.outStartSec + 0.6)!;
    const midB = wallClockAt(plan, boot.outStartSec + 0.7)!;
    const idleRate = midB.wallMs - midA.wallMs;

    expect(idleRate).toBeGreaterThan(activeRate);
  });
});

describe('scene head', () => {
  it('matches the transition length so a fade never overlaps scene motion', async () => {
    const { TRANSITION_SEC } = await import('./layout.js');
    // If these drift apart, a crossfade either overlaps the incoming
    // scene's action or leaves a static gap after the fade.
    expect(SCENE_HEAD_SEC).toBeCloseTo(TRANSITION_SEC, 6);
  });

  it('gives every scene after the first a frozen head', () => {
    const plan = planComposition(script, captures);
    const order = plan.windows[1]!;
    const early = wallClockAt(plan, order.outStartSec + 0.01)!;
    const stillEarly = wallClockAt(plan, order.outStartSec + SCENE_HEAD_SEC - 0.02)!;
    expect(early.window.id).toBe('order');
    // Wall time must not advance while the crossfade is running.
    expect(stillEarly.wallMs).toBeCloseTo(early.wallMs, 0);
    expect(early.wallMs).toBeCloseTo(order.wallStartMs, 0);
  });

  it('starts advancing wall time once the head is over', () => {
    const plan = planComposition(script, captures);
    const order = plan.windows[1]!;
    const atHead = wallClockAt(plan, order.outStartSec + SCENE_HEAD_SEC - 0.02)!;
    const after = wallClockAt(plan, order.outStartSec + SCENE_HEAD_SEC + 0.3)!;
    expect(after.wallMs).toBeGreaterThan(atHead.wallMs);
  });

  it('gives the first scene no head, since nothing fades into it', () => {
    const plan = planComposition(script, captures);
    const boot = plan.windows[0]!;
    const a = wallClockAt(plan, boot.outStartSec + 0.01)!;
    const b = wallClockAt(plan, boot.outStartSec + 0.2)!;
    expect(b.wallMs).toBeGreaterThan(a.wallMs);
  });

  it('holds the head even when the scene is heavily compressed', () => {
    const plan = planComposition(script, captures, {
      idleByScene: { order: [{ startMs: BASE + 3100, endMs: BASE + 5120 }] },
      maxSpeedup: 100,
    });
    const order = plan.windows[1]!;
    const early = wallClockAt(plan, order.outStartSec + 0.01)!;
    const late = wallClockAt(plan, order.outStartSec + SCENE_HEAD_SEC - 0.02)!;
    // This is the reported bug: compression racing ahead during the fade.
    expect(late.wallMs).toBeCloseTo(early.wallMs, 0);
  });
});

describe('scene focus', () => {
  const terminalSessions = new Set(['api']);

  it('carries a terminal focus pattern when the primary is a terminal', () => {
    const withFocus = {
      ...script,
      scenes: [{ id: 'boot', use: 'api', focus: '/POST/' }],
    } as unknown as typeof script;
    const plan = planComposition(withFocus, [captures[0]!], { terminalSessions });
    expect(plan.windows[0]!.focus).toEqual({ kind: 'terminal', pattern: '/POST/' });
  });

  it('carries the measured box when the primary is a browser', () => {
    // A browser focus is a rectangle, not a pattern: the DOM already told
    // us exactly where the element is. Both kinds end up driving the same
    // camera, which is what keeps web and non-web on one mechanism.
    const withFocus = {
      ...script,
      scenes: [{ id: 'order', use: 'web', focus: '#submit' }],
    } as unknown as typeof script;
    const box = { x: 10, y: 20, width: 30, height: 40 };
    const plan = planComposition(withFocus, [captures[1]!], {
      terminalSessions,
      browserFocusByScene: { order: box },
    });
    expect(plan.windows[0]!.focus).toEqual({ kind: 'browser', box });
  });

  it('ignores a browser box when some other session is the one on screen', () => {
    // The box was measured on the acting session. If the layout puts a
    // different session fullscreen, those coordinates mean nothing.
    const withLayout = {
      ...script,
      scenes: [
        { id: 'order', use: 'web', layout: { primary: 'api' } },
      ],
    } as unknown as typeof script;
    const plan = planComposition(withLayout, [captures[1]!], {
      terminalSessions,
      browserFocusByScene: { order: { x: 1, y: 2, width: 3, height: 4 } },
    });
    expect(plan.windows[0]!.focus).toBeNull();
  });

  it('is null when no focus is given', () => {
    const plan = planComposition(script, captures, { terminalSessions });
    expect(plan.windows[0]!.focus).toBeNull();
  });
});
