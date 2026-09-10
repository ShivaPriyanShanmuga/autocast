import {
  BROWSER_ASSERT_KEYS,
  BROWSER_STEP_KEYS,
  TERMINAL_ASSERT_KEYS,
  TERMINAL_STEP_KEYS,
  type DemoScript,
} from '../schema/demo.js';
import type { Diagnostic, Severity } from './diagnostic.js';
import type { ParsedSource } from './parse.js';
import { captionLineChars, wrapCaption, MAX_LINES } from '../render/caption.js';

/**
 * True scene duration is unknowable without running the demo, so this is
 * an absolute ceiling that only catches narration too long for *any*
 * plausible scene. See spec section 8, layer 1.
 */
export const NARRATION_WORD_CEILING = 120;

/**
 * English words a speech engine cannot disambiguate without meaning.
 *
 * Verified rather than assumed: espeak renders "live in about two
 * seconds" as /lˈɪv/ — the verb — which is exactly what shipped in
 * the shipboard demo. It gets "a live broadcast" right, so this is a
 * warning and not an error; the author knows which one they meant.
 *
 * Not exhaustive, and deliberately limited to words that plausibly turn
 * up in a software demo.
 */
export const HETERONYMS = [
  'live', 'read', 'lead', 'close', 'wind', 'tear', 'row', 'bow',
  'minute', 'object', 'present', 'record', 'produce', 'content',
  'invalid', 'resume', 'separate', 'use', 'refuse', 'project',
  'contract', 'permit', 'address', 'progress', 'convert', 'increment',
];

/** The single set key of a step or assertion object, if there is one. */
function soleKey(entry: Record<string, unknown>): string | undefined {
  return Object.keys(entry).find((k) => entry[k] !== undefined);
}

export function lint(script: DemoScript, parsed: ParsedSource): Diagnostic[] {
  const out: Diagnostic[] = [];
  const sessionIds = new Set(Object.keys(script.sessions));
  const usedSessions = new Set<string>();
  const seenSceneIds = new Set<string>();

  const add = (
    severity: Severity,
    code: string,
    message: string,
    path: Array<string | number>,
  ): void => {
    out.push({ severity, code, message, loc: parsed.locate(path) });
  };

  const known = (): string => [...sessionIds].sort().join(', ');

  script.scenes.forEach((scene, i) => {
    if (seenSceneIds.has(scene.id)) {
      add('error', 'L003', `duplicate scene id "${scene.id}"`, ['scenes', i, 'id']);
    }
    seenSceneIds.add(scene.id);

    const backend = sessionIds.has(scene.use) ? script.sessions[scene.use]!.backend : null;
    if (backend === null) {
      add(
        'error',
        'L001',
        `scene "${scene.id}" uses session "${scene.use}", which is not declared. Declared sessions: ${known()}`,
        ['scenes', i, 'use'],
      );
    } else {
      usedSessions.add(scene.use);
    }

    if (scene.layout) {
      const refs: Array<[string, Array<string | number>]> = [
        [scene.layout.primary, ['scenes', i, 'layout', 'primary']],
      ];
      if (scene.layout.inset) {
        refs.push([scene.layout.inset.session, ['scenes', i, 'layout', 'inset', 'session']]);
      }
      for (const [id, path] of refs) {
        if (!sessionIds.has(id)) {
          add(
            'error',
            'L002',
            `layout in scene "${scene.id}" references session "${id}", which is not declared. Declared sessions: ${known()}`,
            path,
          );
        } else {
          usedSessions.add(id);
        }
      }
    }

    if (!scene.assert || scene.assert.length === 0) {
      add(
        'warning',
        'L004',
        `scene "${scene.id}" has no assertions — a demo that silently records an error state is worse than no demo`,
        ['scenes', i, 'id'],
      );
    }

    scene.steps?.forEach((step, j) => {
      const key = soleKey(step as Record<string, unknown>);
      if (key === undefined) return;

      for (const pattern of patternsIn(step)) {
        if (mayBacktrack(pattern)) {
          add(
            'warning',
            'L011',
            `pattern ${pattern} nests one repetition inside another, which can backtrack ` +
              'catastrophically — a single match blocks the event loop, so the render hangs ' +
              'with no output and no timeout can fire',
            ['scenes', i, 'steps', j, key],
          );
        }
      }

      if (key === 'sleep') {
        add(
          'warning',
          'L005',
          'sleep makes the render fragile on slower machines — prefer wait_for',
          ['scenes', i, 'steps', j, 'sleep'],
        );
      }

      if (backend === 'terminal' && BROWSER_STEP_KEYS.has(key)) {
        add(
          'error',
          'L008',
          `step "${key}" is browser-only, but session "${scene.use}" is a terminal`,
          ['scenes', i, 'steps', j, key],
        );
      }
      if (backend === 'browser' && TERMINAL_STEP_KEYS.has(key)) {
        add(
          'error',
          'L008',
          `step "${key}" is terminal-only, but session "${scene.use}" is a browser`,
          ['scenes', i, 'steps', j, key],
        );
      }
      if (key === 'wait_for' && backend === 'browser' && step.wait_for?.stdout !== undefined) {
        add('error', 'L008', 'wait_for.stdout is terminal-only, but this session is a browser', [
          'scenes',
          i,
          'steps',
          j,
          'wait_for',
          'stdout',
        ]);
      }
      if (key === 'wait_for' && backend === 'terminal' && step.wait_for?.selector !== undefined) {
        add('error', 'L008', 'wait_for.selector is browser-only, but this session is a terminal', [
          'scenes',
          i,
          'steps',
          j,
          'wait_for',
          'selector',
        ]);
      }
    });

    scene.assert?.forEach((assertion, j) => {
      const key = soleKey(assertion as Record<string, unknown>);
      if (key === undefined) return;

      if (backend === 'terminal' && BROWSER_ASSERT_KEYS.has(key)) {
        add(
          'error',
          'L009',
          `assertion "${key}" is browser-only, but session "${scene.use}" is a terminal`,
          ['scenes', i, 'assert', j, key],
        );
      }
      if (backend === 'browser' && TERMINAL_ASSERT_KEYS.has(key)) {
        add(
          'error',
          'L009',
          `assertion "${key}" is terminal-only, but session "${scene.use}" is a browser`,
          ['scenes', i, 'assert', j, key],
        );
      }
    });

    if (scene.narrate !== undefined) {
      const words = scene.narrate.trim().split(/\s+/).filter(Boolean).length;
      if (words > NARRATION_WORD_CEILING) {
        add(
          'warning',
          'L007',
          `narration in scene "${scene.id}" is ${words} words, over the ${NARRATION_WORD_CEILING}-word ceiling — it will outrun any plausible scene`,
          ['scenes', i, 'narrate'],
        );
      }

      // Asked through the same functions the renderer uses, so the
      // warning predicts exactly what the caption will do rather than
      // approximating it.
      // Only when something will actually SAY it. Captions show the word
      // as written, so a silent demo has no pronunciation to get wrong
      // and warning there would be noise.
      if (script.voice?.enabled === true && scene.speak === undefined) {
        const found = HETERONYMS.filter((w) =>
          new RegExp(`\\b${w}\\b`, 'i').test(scene.narrate ?? ''),
        );
        if (found.length > 0) {
          add(
            'warning',
            'L010',
            `narration in scene "${scene.id}" contains ${found
              .map((w) => `"${w}"`)
              .join(', ')}, which a speech engine may pronounce the wrong way — ` +
              'add speak: with a respelling if it does',
            ['scenes', i, 'narrate'],
          );
        }
      }

      const chars = captionLineChars(script.output?.canvas?.[0] ?? 1280);
      const lines = wrapCaption(scene.narrate, chars);
      if (lines.join('').endsWith('…')) {
        add(
          'warning',
          'L008',
          `narration in scene "${scene.id}" does not fit in ${MAX_LINES} caption lines and will be truncated`,
          ['scenes', i, 'narrate'],
        );
      }
    }
  });

  for (const id of sessionIds) {
    if (!usedSessions.has(id)) {
      add('warning', 'L006', `session "${id}" is declared but never used`, ['sessions', id]);
    }
  }

  return out;
}

/**
 * A repetition nested inside another repetition: `(a+)+`, `(x*)*`.
 *
 * These backtrack exponentially. Measured: `/^(a+)+$/` against 33
 * characters never returns. That matters more here than in most places,
 * because a single `re.test()` blocks the event loop — so the deadline
 * inside `waitUntil` never gets a chance to fire, and the render hangs
 * with no output rather than timing out with an error.
 *
 * A warning rather than an error: the shape is only a risk, and an author
 * who knows their input is short is entitled to it.
 */
export function mayBacktrack(pattern: string): boolean {
  if (!pattern.startsWith('/')) return false; // literal, escaped before use
  const end = pattern.lastIndexOf('/');
  if (end <= 0) return false;
  const source = pattern.slice(1, end);
  // A group whose body contains a quantifier, immediately followed by
  // another quantifier. Deliberately simple: this is a warning about a
  // shape, not a decision procedure, and a heuristic that anyone can
  // read beats one that is right more often and understood by nobody.
  return /\([^)]*[+*][^)]*\)\s*[+*]/.test(source);
}

/** Pattern-shaped strings inside a step or assertion object. */
export function patternsIn(node: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.startsWith('/')) out.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') return Object.values(v).forEach(walk);
  };
  walk(node);
  return out;
}
