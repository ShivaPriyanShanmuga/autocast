import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { ResolvedStyle } from './style.js';

/**
 * Wraps the composed frame in a presentation frame.
 *
 * Entirely a compositor pass: it never touches capture, never changes
 * timing, and re-renders without re-running anything (spec section 7.2).
 */
export class Presenter {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly style: ResolvedStyle,
  ) {
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
  }

  /** True when this presenter would leave a frame unchanged. */
  get isPlain(): boolean {
    return (
      this.style.background.kind === 'none' &&
      this.style.padding === 0 &&
      this.style.radius === 0 &&
      !this.style.shadow
    );
  }

  present(source: Canvas): Buffer {
    // A demo without style: must be byte-identical to before this phase,
    // so do not even copy it through our canvas.
    if (this.isPlain) return Buffer.from(source.data());

    const { ctx, width, height, style } = this;

    if (style.background.kind === 'gradient') {
      const g = ctx.createLinearGradient(0, 0, width, height);
      const colors = style.background.colors;
      colors.forEach((c, i) => g.addColorStop(i / Math.max(1, colors.length - 1), c));
      ctx.fillStyle = g;
    } else if (style.background.kind === 'solid') {
      ctx.fillStyle = style.background.color;
    } else {
      ctx.fillStyle = '#000000';
    }
    ctx.fillRect(0, 0, width, height);

    const pad = style.padding;
    const w = Math.max(1, width - pad * 2);
    const h = Math.max(1, height - pad * 2);

    if (style.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = Math.max(12, pad * 0.7);
      ctx.shadowOffsetY = Math.max(4, pad * 0.25);
      ctx.fillStyle = '#000000';
      roundedPath(ctx, pad, pad, w, h, style.radius);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    roundedPath(ctx, pad, pad, w, h, style.radius);
    ctx.clip();
    ctx.drawImage(source, pad, pad, w, h);
    ctx.restore();

    return Buffer.from(this.canvas.data());
  }
}

function roundedPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
