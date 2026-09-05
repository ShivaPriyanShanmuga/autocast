import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { Presenter } from './present.js';
import { PLAIN, resolveStyle } from './style.js';

const W = 320;
const H = 180;

function solid(colour: string, w = W, h = H) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  return c;
}

const styled = resolveStyle({
  background: { gradient: ['#101018', '#202038'], padding: 24 },
  window: { radius: 10, shadow: true },
});

describe('Presenter', () => {
  it('returns a buffer of the right size', () => {
    const p = new Presenter(W, H, styled);
    expect(p.present(solid('#ff0000')).length).toBe(W * H * 4);
  });

  it('is a pass-through when the style is plain', () => {
    const p = new Presenter(W, H, PLAIN);
    const src = solid('#ff0000');
    expect(Buffer.compare(p.present(src), Buffer.from(src.data()))).toBe(0);
    expect(p.isPlain).toBe(true);
  });

  it('changes the frame when styled', () => {
    const src = solid('#ff0000');
    const plain = new Presenter(W, H, PLAIN).present(src);
    const fancy = new Presenter(W, H, styled).present(src);
    expect(Buffer.compare(plain, fancy)).not.toBe(0);
  });

  it('paints background in the padding, not source content', () => {
    const out = new Presenter(W, H, styled).present(solid('#ff0000'));
    expect(out[0]!).toBeLessThan(120);
  });

  it('keeps the source visible in the middle', () => {
    const out = new Presenter(W, H, styled).present(solid('#ff0000'));
    const mid = (H / 2) * W * 4 + (W / 2) * 4;
    expect(out[mid]!).toBeGreaterThan(180);
  });

  it('rounds the corners of the inset content', () => {
    const rounded = new Presenter(W, H, styled).present(solid('#ff0000'));
    const square = new Presenter(
      W,
      H,
      resolveStyle({ background: { gradient: ['#101018', '#202038'], padding: 24 } }),
    ).present(solid('#ff0000'));
    expect(Buffer.compare(rounded, square)).not.toBe(0);
  });

  it('is deterministic', () => {
    const p = new Presenter(W, H, styled);
    const src = solid('#00ff00');
    expect(Buffer.compare(p.present(src), p.present(src))).toBe(0);
  });

  it('handles a solid background', () => {
    const p = new Presenter(W, H, resolveStyle({ background: { color: '#123456', padding: 20 } }));
    expect(p.present(solid('#ff0000'))[0]!).toBeCloseTo(0x12, -1);
  });
});
