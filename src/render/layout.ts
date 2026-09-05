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

/** How long a scene cut takes to blend. */
export const TRANSITION_SEC = 0.35;

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
  private hold: Canvas | null = null;

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

  get surface(): Canvas {
    return this.canvas;
  }

  /**
   * Remember the current frame so it can be faded out over the next
   * scene.
   *
   * Snapshotting is what makes a crossfade possible at all: the outgoing
   * scene cannot simply be re-rendered, because a forward-only
   * CastPlayer would have to seek backwards to produce it again. At a
   * scene boundary the outgoing scene is in its frozen tail, so a
   * snapshot loses nothing.
   */
  snapshot(): void {
    this.hold ??= createCanvas(this.width, this.height);
    const ctx = this.hold.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.canvas, 0, 0);
  }

  /** Draw the snapshotted frame over the current one. */
  fadeInPrevious(alpha: number): void {
    if (!this.hold || alpha <= 0) return;
    this.ctx.save();
    this.ctx.globalAlpha = Math.min(1, alpha);
    this.ctx.drawImage(this.hold, 0, 0);
    this.ctx.restore();
  }

  clear(): void {
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * Fit a source to the canvas, preserving aspect ratio.
   *
   * With a camera, that region of the source fills the canvas instead —
   * which is how zoom and panning are expressed. Moving a rectangle over
   * a surface rendered once is smooth; re-rendering at a larger font per
   * frame snaps to whole pixels and jitters.
   */
  drawFullscreen(source: Drawable, camera?: Rect): void {
    if (camera) {
      this.ctx.drawImage(
        source,
        camera.x,
        camera.y,
        camera.width,
        camera.height,
        0,
        0,
        this.width,
        this.height,
      );
      return;
    }

    const sw = source.width;
    const sh = source.height;
    const scale = Math.min(this.width / sw, this.height / sh);
    const w = sw * scale;
    const h = sh * scale;
    this.ctx.drawImage(source, (this.width - w) / 2, (this.height - h) / 2, w, h);
  }

  drawInset(source: Drawable, spec: InsetSpec, radius = 0): void {
    const r = insetRect(this.width, this.height, spec);
    const { ctx } = this;
    // Match the presentation frame's corner radius, scaled down with the
    // inset, so the two windows read as the same kind of object.
    const rad = Math.max(0, Math.min(radius * spec.scale * 1.6, r.width / 2, r.height / 2));

    // A shadow and border so the inset reads as a separate window rather
    // than a rectangle of noise pasted over the primary.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = this.theme.background;
    roundedRectPath(ctx, r.x, r.y, r.width, r.height, rad);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedRectPath(ctx, r.x, r.y, r.width, r.height, rad);
    ctx.clip();
    const scale = Math.min(r.width / source.width, r.height / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.drawImage(source, r.x + (r.width - w) / 2, r.y + (r.height - h) / 2, w, h);
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    roundedRectPath(ctx, r.x + 1, r.y + 1, r.width - 2, r.height - 2, Math.max(0, rad - 1));
    ctx.stroke();
  }

  readPixels(): Buffer {
    return Buffer.from(this.canvas.data());
  }
}

function roundedRectPath(
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
