import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { ensureFontRegistered, measureCell } from './font.js';
import type { ScreenState } from './screen.js';
import type { CellRect } from './find-in-screen.js';
import type { Theme } from './theme.js';

export interface FrameGeometry {
  width: number;
  height: number;
  fontSizePx: number;
  padding: number;
}

const PADDING = 20;
const LINE_HEIGHT_RATIO = 1.35;

/**
 * Pick the largest font size at which the whole grid fits the canvas.
 * Measured once against the real font, since advance width is a property
 * of the face and not something to assume.
 */
export function fitGeometry(
  cols: number,
  rows: number,
  canvasW: number,
  canvasH: number,
): FrameGeometry {
  ensureFontRegistered();
  const usableW = canvasW - PADDING * 2;
  const usableH = canvasH - PADDING * 2;

  // Advance width scales linearly with font size, so measure once at a
  // reference size and solve rather than searching.
  const probe = measureCell(100, LINE_HEIGHT_RATIO);
  const widthRatio = probe.cellWidth / 100;
  const heightRatio = probe.cellHeight / 100;

  const byWidth = usableW / (cols * widthRatio);
  const byHeight = usableH / (rows * heightRatio);
  const fontSizePx = Math.max(4, Math.floor(Math.min(byWidth, byHeight)));

  return { width: canvasW, height: canvasH, fontSizePx, padding: PADDING };
}

export class FrameRenderer {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  private readonly baselineOffset: number;
  private readonly fontSpec: string;

  constructor(
    readonly geometry: FrameGeometry,
    private readonly theme: Theme,
  ) {
    ensureFontRegistered();
    // One canvas for the whole render: allocating 1280x720 per frame would
    // dominate the runtime.
    this.canvas = createCanvas(geometry.width, geometry.height);
    this.ctx = this.canvas.getContext('2d');
    const metrics = measureCell(geometry.fontSizePx, LINE_HEIGHT_RATIO);
    this.cellWidth = metrics.cellWidth;
    this.cellHeight = metrics.cellHeight;
    this.baselineOffset = metrics.baselineOffset;
    this.fontSpec = metrics.fontSpec;
  }

  /** The composed frame, for a compositor to draw from. */
  get surface(): Canvas {
    return this.canvas;
  }

  /** Compose onto the internal canvas; read with render() or surface. */
  compose(screen: ScreenState): void {
    const { ctx, theme, geometry } = this;

    // Full clear every frame: without it, a shrinking screen would leave
    // the previous frame's glyphs behind.
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, geometry.width, geometry.height);

    ctx.textBaseline = 'alphabetic';

    for (let y = 0; y < screen.rows; y++) {
      const row = screen.cells[y];
      if (!row) continue;
      const top = geometry.padding + y * this.cellHeight;

      // Backgrounds first, as one pass, so glyphs are never clipped by a
      // neighbouring cell's background.
      for (let x = 0; x < screen.cols; x++) {
        const cell = row[x];
        if (!cell || cell.width === 0) continue;
        if (cell.bg === theme.background) continue;
        ctx.fillStyle = cell.bg;
        ctx.fillRect(
          geometry.padding + x * this.cellWidth,
          top,
          this.cellWidth * Math.max(1, cell.width),
          this.cellHeight,
        );
      }

      const baseline = top + this.baselineOffset;
      for (let x = 0; x < screen.cols; x++) {
        const cell = row[x];
        if (!cell || cell.width === 0) continue;
        if (cell.char === ' ' && !cell.underline) continue;

        const weight = cell.bold ? 'bold ' : '';
        const style = cell.italic ? 'italic ' : '';
        ctx.font = `${style}${weight}${this.fontSpec}`;
        ctx.globalAlpha = cell.dim ? 0.6 : 1;
        ctx.fillStyle = cell.fg;

        const left = geometry.padding + x * this.cellWidth;
        if (cell.char !== ' ') ctx.fillText(cell.char, left, baseline);

        if (cell.underline) {
          ctx.fillRect(left, baseline + 2, this.cellWidth * Math.max(1, cell.width), 1);
        }
        ctx.globalAlpha = 1;
      }
    }

  }

  readPixels(): Buffer {
    return Buffer.from(this.canvas.data());
  }

  /**
   * Compose the terminal zoomed toward a region of the grid.
   *
   * Lossless, unlike the browser: we render the character grid ourselves,
   * so zooming re-rasterises glyphs at a larger size rather than
   * upscaling pixels. The grid is drawn at `zoom` times the canvas and
   * then cropped around the focus, so text stays sharp at any factor.
   */
  composeZoomed(screen: ScreenState, focus: CellRect | null, zoom: number): void {
    if (zoom <= 1.001 || focus === null) {
      this.compose(screen);
      return;
    }

    const { width, height } = this.geometry;
    const big = new FrameRenderer(
      {
        width: Math.round(width * zoom),
        height: Math.round(height * zoom),
        fontSizePx: Math.max(4, Math.round(this.geometry.fontSizePx * zoom)),
        padding: Math.round(this.geometry.padding * zoom),
      },
      this.theme,
    );
    big.compose(screen);

    // Centre the crop on the focused cells, clamped inside the frame.
    const cellW = (big.geometry.width - big.geometry.padding * 2) / Math.max(1, screen.cols);
    const cellH = (big.geometry.height - big.geometry.padding * 2) / Math.max(1, screen.rows);
    const cx = big.geometry.padding + (focus.col + focus.width / 2) * cellW;
    const cy = big.geometry.padding + (focus.row + focus.height / 2) * cellH;

    const sx = Math.max(0, Math.min(cx - width / 2, big.geometry.width - width));
    const sy = Math.max(0, Math.min(cy - height / 2, big.geometry.height - height));

    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.drawImage(big.surface, sx, sy, width, height, 0, 0, width, height);
  }

  render(screen: ScreenState): Buffer {
    this.compose(screen);
    return this.readPixels();
  }
}
