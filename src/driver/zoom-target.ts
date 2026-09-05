import type { Scene } from '../schema/demo.js';

export interface ZoomIntent {
  selector: string;
  source: 'focus' | 'auto';
}

export interface ZoomStyle {
  zoomAuto: boolean;
  zoomOn: 'click' | 'focus';
}

/**
 * What a scene should frame, if anything.
 *
 * An explicit `focus:` always wins — the author said what mattered.
 * Otherwise auto-zoom picks the LAST click: we know the element's exact
 * bounding box from the DOM, which is why our framing can beat a screen
 * recorder's guess (spec section 7.2), but zooming in and out on every
 * click in a three-click scene is nauseating.
 */
export function zoomIntentFor(scene: Scene, style: ZoomStyle): ZoomIntent | null {
  if (typeof scene.focus === 'string' && scene.focus.length > 0) {
    return { selector: scene.focus, source: 'focus' };
  }
  if (!style.zoomAuto) return null;

  const clicks = (scene.steps ?? [])
    .map((s) => (s as { click?: unknown }).click)
    .filter((c): c is string => typeof c === 'string');

  const last = clicks[clicks.length - 1];
  return last ? { selector: last, source: 'auto' } : null;
}
