import type { DemoScript } from '../schema/demo.js';
import { evaluateAssertion, type AssertResult } from '../backends/terminal/assertions.js';
import type { CastLog } from '../backends/terminal/cast.js';
import { openTerminalSession, type TerminalSession } from '../backends/terminal/session.js';
import { executeStep, type StepResult } from '../backends/terminal/steps.js';

export interface SceneCapture {
  id: string;
  steps: StepResult[];
  assertions: AssertResult[];
  ok: boolean;
  startedAt: number;
  endedAt: number;
}

export interface CaptureArtifact {
  scenes: SceneCapture[];
  casts: Record<string, CastLog>;
  ok: boolean;
}

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

export async function captureTerminalDemo(
  script: DemoScript,
  opts: { now?: () => number } = {},
): Promise<CaptureArtifact> {
  const now = opts.now ?? (() => Date.now());

  for (const [id, session] of Object.entries(script.sessions)) {
    if (session.backend !== 'terminal') {
      throw new Error(
        `session "${id}" uses the ${session.backend} backend, which arrives in Phase 2. ` +
          'Phase 1 captures terminal sessions only.',
      );
    }
  }

  const typingSpeedMs = toMs(script.defaults?.typing_speed, 45);
  const settleMs = toMs(script.defaults?.settle, 400);

  // Insertion order is declaration order; teardown reverses it (spec 4.6).
  const sessions = new Map<string, TerminalSession>();
  const casts: Record<string, CastLog> = {};
  const scenes: SceneCapture[] = [];

  try {
    for (const [id, config] of Object.entries(script.sessions)) {
      if (config.backend !== 'terminal') continue;
      sessions.set(
        id,
        await openTerminalSession({
          cols: config.cols ?? 80,
          rows: config.rows ?? 24,
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          ...(config.env === undefined ? {} : { env: config.env }),
          now,
        }),
      );
    }

    for (const scene of script.scenes) {
      const session = sessions.get(scene.use);
      if (!session) throw new Error(`scene "${scene.id}" uses unknown session "${scene.use}"`);

      const startedAt = now();
      const steps: StepResult[] = [];
      const assertions: AssertResult[] = [];

      for (const step of scene.steps ?? []) {
        const result = await executeStep(step as Record<string, unknown>, {
          session,
          seed: scene.id,
          typingSpeedMs,
          settleMs,
          now,
        });
        steps.push(result);
        if (!result.ok) break; // a failed step invalidates everything after it
      }

      for (const assertion of scene.assert ?? []) {
        assertions.push(await evaluateAssertion(assertion as Record<string, unknown>, session));
      }

      scenes.push({
        id: scene.id,
        steps,
        assertions,
        ok: steps.every((s) => s.ok) && assertions.every((a) => a.ok),
        startedAt,
        endedAt: now(),
      });
    }

    for (const [id, session] of sessions) casts[id] = session.cast();
    return { scenes, casts, ok: scenes.every((s) => s.ok) };
  } finally {
    // Reverse declaration order, and never let one failure strand another.
    for (const [id, session] of [...sessions].reverse()) {
      casts[id] ??= session.cast();
      await session.dispose().catch(() => undefined);
    }
  }
}
