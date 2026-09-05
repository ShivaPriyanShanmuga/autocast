import type { DemoScript } from '../schema/demo.js';

export type ResolvedBackground =
  | { kind: 'none' }
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; colors: string[] };

export interface ResolvedStyle {
  background: ResolvedBackground;
  padding: number;
  radius: number;
  shadow: boolean;
  /** Multiplier on the drawn cursor. */
  cursorSize: number;
}

/**
 * What a demo with no `style:` block gets.
 *
 * Deliberately inert: an existing demo must render exactly as it did
 * before this phase, so every value here is a no-op.
 */
export const PLAIN: ResolvedStyle = {
  background: { kind: 'none' },
  padding: 0,
  radius: 0,
  shadow: false,
  cursorSize: 1,
};

/** Padding used when a background is requested without one. */
const DEFAULT_PADDING = 48;

export function resolveStyle(style: DemoScript['style']): ResolvedStyle {
  if (!style) return PLAIN;

  const bg = style.background;
  let background: ResolvedBackground = { kind: 'none' };
  if (bg?.gradient && bg.gradient.length >= 2) {
    background = { kind: 'gradient', colors: [...bg.gradient] };
  } else if (bg?.color) {
    background = { kind: 'solid', color: bg.color };
  }

  const hasBackground = background.kind !== 'none';
  const padding = bg?.padding ?? (hasBackground ? DEFAULT_PADDING : 0);

  return {
    background,
    padding,
    radius: style.window?.radius ?? 0,
    shadow: style.window?.shadow ?? false,
    cursorSize: style.cursor?.size ?? 1,
  };
}
