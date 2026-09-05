import { describe, it, expect } from 'vitest';
import type { DemoScript } from '../schema/demo.js';
import type { SceneCapture } from '../driver/capture.js';
import { planComposition, wallClockAt, MIN_SCENE_SEC } from './composition.js';

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

  it('uses the measured duration when it exceeds the minimum', () => {
    const plan = planComposition(script, captures);
    const boot = plan.windows[0]!;
    expect(boot.outEndSec - boot.outStartSec).toBeCloseTo(3.1, 3);
  });

  it('gives a zero-duration scene a minimum hold instead of one frame', () => {
    const plan = planComposition(script, captures);
    const logs = plan.windows[2]!;
    expect(logs.outEndSec - logs.outStartSec).toBeCloseTo(MIN_SCENE_SEC, 3);
  });

  it('honours an overridden minimum', () => {
    const plan = planComposition(script, captures, { minSceneSec: 3 });
    const logs = plan.windows[2]!;
    expect(logs.outEndSec - logs.outStartSec).toBeCloseTo(3, 3);
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
    const r = wallClockAt(plan, 4.0)!;
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
