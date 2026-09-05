import { z } from 'zod';
import { compilePattern } from './pattern.js';

/** A duration: a non-negative integer of milliseconds, or "400ms" / "1.5s". */
const Duration = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+(?:\.\d+)?(?:ms|s)$/, 'duration must look like "400ms" or "1.5s"'),
]);

/** A literal substring, or a `/regex/flags` that must compile. */
const Pattern = z.string().refine((s) => compilePattern(s) !== null, {
  message: 'invalid regular expression',
});

/** True when exactly one key of the object is set. */
function hasExactlyOneKey(value: object): boolean {
  return Object.values(value).filter((v) => v !== undefined).length === 1;
}

const WaitFor = z
  .object({
    stdout: Pattern.optional(),
    selector: z.string().optional(),
    timeout: Duration.optional(),
  })
  .strict()
  .refine((v) => (v.stdout === undefined) !== (v.selector === undefined), {
    message: 'wait_for needs exactly one of stdout or selector',
  });

const Step = z
  .object({
    type: z.string().optional(),
    key: z.string().optional(),
    goto: z.string().optional(),
    click: z.string().optional(),
    fill: z.object({ selector: z.string(), value: z.string() }).strict().optional(),
    run: z.string().optional(),
    sleep: Duration.optional(),
    wait_for: WaitFor.optional(),
  })
  .strict()
  .refine(hasExactlyOneKey, { message: 'a step must have exactly one action key' });

const Assertion = z
  .object({
    process_alive: z.boolean().optional(),
    exit_code: z.number().int().optional(),
    stdout_contains: z.string().optional(),
    stdout_matches: Pattern.optional(),
    stderr_empty: z.boolean().optional(),
    visible: z.string().optional(),
    hidden: z.string().optional(),
    text_matches: Pattern.optional(),
    url_matches: Pattern.optional(),
    no_console_errors: z.boolean().optional(),
    no_failed_requests: z.boolean().optional(),
  })
  .strict()
  .refine(hasExactlyOneKey, { message: 'an assertion must have exactly one action key' });

/** Step keys that only make sense against a given backend. See spec §5. */
export const BROWSER_STEP_KEYS: ReadonlySet<string> = new Set(['goto', 'click', 'fill']);
export const TERMINAL_STEP_KEYS: ReadonlySet<string> = new Set(['run']);
export const BROWSER_ASSERT_KEYS: ReadonlySet<string> = new Set([
  'visible',
  'hidden',
  'text_matches',
  'url_matches',
  'no_console_errors',
  'no_failed_requests',
]);
export const TERMINAL_ASSERT_KEYS: ReadonlySet<string> = new Set([
  'process_alive',
  'exit_code',
  'stdout_contains',
  'stdout_matches',
  'stderr_empty',
]);

const TerminalSession = z
  .object({
    backend: z.literal('terminal'),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  })
  .strict();

const BrowserSession = z
  .object({
    backend: z.literal('browser'),
    viewport: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    attach: z.object({ cdp: z.string() }).strict().optional(),
  })
  .strict();

const SessionSchema = z.discriminatedUnion('backend', [TerminalSession, BrowserSession]);

const Layout = z
  .object({
    primary: z.string(),
    inset: z
      .object({
        session: z.string(),
        corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
        scale: z.number().positive().max(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const SceneSchema = z
  .object({
    id: z.string().min(1),
    use: z.string().min(1),
    narrate: z.string().optional(),
    focus: z.string().optional(),
    layout: Layout.optional(),
    steps: z.array(Step).optional(),
    assert: z.array(Assertion).optional(),
    sync: z.enum(['hold', 'strict']).optional(),
    on_assert_fail: z.enum(['abort', 'continue', 'warn']).optional(),
  })
  .strict();

/** Phase 5. Validated now so styled scripts are forward-compatible. */
const Style = z
  .object({
    background: z
      .object({
        gradient: z.array(z.string()).min(2).optional(),
        color: z.string().optional(),
        padding: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    window: z
      .object({
        radius: z.number().int().nonnegative().optional(),
        shadow: z.boolean().optional(),
      })
      .strict()
      .optional(),
    zoom: z
      .object({
        auto: z.boolean().optional(),
        on: z.enum(['click', 'focus']).optional(),
        scale: z.number().positive().optional(),
        ease: z.enum(['spring', 'cubic']).optional(),
        duration: Duration.optional(),
      })
      .strict()
      .optional(),
    cursor: z.object({ size: z.number().positive().optional() }).strict().optional(),
    motion_blur: z
      .object({
        cursor: z.boolean().optional(),
        zoom: z.boolean().optional(),
        pan: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DemoScript = z
  .object({
    autocast: z.literal(1),
    output: z
      .object({
        path: z.string().min(1),
        canvas: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
          .default([1280, 720]),
        fps: z.number().int().positive().default(30),
      })
      .strict(),
    defaults: z
      .object({ typing_speed: Duration.optional(), settle: Duration.optional() })
      .strict()
      .optional(),
    style: Style.optional(),
    sessions: z.record(z.string().min(1), SessionSchema),
    scenes: z.array(SceneSchema).min(1),
  })
  .strict();

export type DemoScript = z.infer<typeof DemoScript>;
export type Scene = z.infer<typeof SceneSchema>;
export type Session = z.infer<typeof SessionSchema>;
