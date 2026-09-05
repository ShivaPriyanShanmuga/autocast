import { describe, it, expect } from 'vitest';
import { zoomIntentFor } from './zoom-target.js';

const auto = { zoomAuto: true, zoomOn: 'click' as const };
const off = { zoomAuto: false, zoomOn: 'click' as const };

const scene = (over: Record<string, unknown> = {}) =>
  ({ id: 's', use: 'web', ...over }) as never;

describe('zoomIntentFor', () => {
  it('prefers an explicit focus', () => {
    expect(zoomIntentFor(scene({ focus: '#explicit' }), auto)).toEqual({
      selector: '#explicit',
      source: 'focus',
    });
  });

  it('honours focus even when auto is off', () => {
    expect(zoomIntentFor(scene({ focus: '#explicit' }), off)?.source).toBe('focus');
  });

  it('returns nothing when auto is off and there is no focus', () => {
    expect(zoomIntentFor(scene({ steps: [{ click: '#a' }] }), off)).toBeNull();
  });

  it('picks the last click when auto is on', () => {
    const i = zoomIntentFor(
      scene({
        steps: [
          { click: '#first' },
          { fill: { selector: '#q', value: '2' } },
          { click: '#last' },
        ],
      }),
      auto,
    );
    // Zooming on every click in a multi-click scene is nauseating; the
    // last one is the result worth framing.
    expect(i).toEqual({ selector: '#last', source: 'auto' });
  });

  it('returns nothing when the scene has no clicks', () => {
    expect(zoomIntentFor(scene({ steps: [{ goto: 'http://x' }] }), auto)).toBeNull();
  });

  it('returns nothing for a scene with no steps', () => {
    expect(zoomIntentFor(scene({}), auto)).toBeNull();
  });

  it('ignores non-click steps when choosing', () => {
    const i = zoomIntentFor(
      scene({ steps: [{ click: '#only' }, { wait_for: { selector: '.done' } }] }),
      auto,
    );
    expect(i?.selector).toBe('#only');
  });
});
