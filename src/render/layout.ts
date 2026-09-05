import { createCanvas, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import type { InsetSpec } from './composition.js';
import type { Theme } from './theme.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_MARGIN = 24;

/** Where an inset sits, keeping the canvas aspect ratio. */
export function insetRect(
  canvasW: number,
  canvasH: number,
  spec: InsetSpec,
  margin = DEFAULT_MARGIN,
): Rect {
  const width = Math.round(canvasW * spec.scale);
  const height = Math.round(width * (canvasH / canvasW));

  const left = margin;
  const right = canvasW - width - margin;
  const top = margin;
  const bottom = canvasH - height - margin;

  const x = spec.corner === 'top-left' || spec.corner === 'bottom-left' ? left : right;
  const y = spec.corner === 'top-left' || spec.corner === 'top-right' ? top : bottom;

  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

type Drawable = Canvas | Image;

/**
 * Composes one or two sources onto the shared canvas.
 *
 * Every source is normalised to this canvas, which is what makes a
 * terminal-to-browser cut continuous rather than a resolution pop
 * (spec section 4.4).
 */
export class LayoutCompositor {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly theme: Theme,
  ) {
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
  }

  get context(): SKRSContext2D {
    return this.ctx;
  }

  clear(): void {
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Fit a source to the canvas, preserving aspect ratio. */
  drawFullscreen(source: Drawable): void {
    const sw = source.width;
    const sh = source.height;
    const scale = Math.min(this.width / sw, this.height / sh);
    const w = sw * scale;
    const h = sh * scale;
    this.ctx.drawImage(source, (this.width - w) / 2, (this.height - h) / 2, w, h);
  }

  drawInset(source: Drawable, spec: InsetSpec): void {
    const r = insetRect(this.width, this.height, spec);
    const { ctx } = this;

    // A shadow and border so the inset reads as a separate window rather
    // than a rectangle of noise pasted over the primary.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    const scale = Math.min(r.width / source.width, r.height / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.drawImage(source, r.x + (r.width - w) / 2, r.y + (r.height - h) / 2, w, h);
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
  }

  readPixels(): Buffer {
    return Buffer.from(this.canvas.data());
  }
}
