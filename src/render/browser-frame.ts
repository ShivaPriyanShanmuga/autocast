import { readFile } from 'node:fs/promises';
import {
  createCanvas,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import {
  cursorAt,
  drawCursor,
  scaleAt,
  type CursorKeyframe,
  type ZoomKeyframe,
} from './cursor.js';
import type { Theme } from './theme.js';

export interface BrowserFrameGeometry {
  width: number;
  height: number;
}

/** How the page was fitted onto the surface, in surface pixels. */
export interface PageFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Draws captured browser JPEGs onto the shared canvas.
 *
 * The resampler holds one source across many ticks, so the decoded image
 * is cached: without it a 30fps render of a still page would decode the
 * same JPEG ninety times per second of video.
 */
export class BrowserFrameRenderer {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;
  private cachedPath: string | null = null;
  private cachedImage: Image | null = null;
  /** Test-visible: how many times a JPEG was actually decoded. */
  decodeCount = 0;
  private fit: PageFit = { scale: 1, offsetX: 0, offsetY: 0 };

  constructor(
    private readonly geometry: BrowserFrameGeometry,
    private readonly theme: Theme,
  ) {
    this.canvas = createCanvas(geometry.width, geometry.height);
    this.ctx = this.canvas.getContext('2d');
  }

  /** Draw on the composed frame before it is read out. */
  get context(): SKRSContext2D {
    return this.ctx;
  }

  /** The composed frame, for a compositor to draw from. */
  get surface(): Canvas {
    return this.canvas;
  }

  /**
   * How the last composed page maps onto this surface.
   *
   * Anything drawn in page coordinates — the cursor, and a focus box —
   * has to go through this, or it lands somewhere the page is not. It
   * matters now that a surface can be larger than the viewport: the
   * compositor supersamples the browser so a zoom camera has real pixels
   * to move over, and a cursor drawn in raw CSS pixels on a 1.7x surface
   * sits well up and left of the thing it is pointing at.
   */
  get pageFit(): PageFit {
    return this.fit;
  }

  private async imageFor(path: string): Promise<Image | null> {
    if (this.cachedPath === path && this.cachedImage) return this.cachedImage;
    try {
      const image = await loadImage(await readFile(path));
      this.decodeCount++;
      this.cachedPath = path;
      this.cachedImage = image;
      return image;
    } catch {
      // A frame that will not decode is a lost frame, not a lost render.
      this.cachedPath = null;
      this.cachedImage = null;
      return null;
    }
  }

  /** Compose the page frame; draw overlays, then call readPixels(). */
  async compose(jpegPath: string | null): Promise<void> {
    const { ctx, geometry, theme } = this;

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, geometry.width, geometry.height);

    const image = jpegPath === null ? null : await this.imageFor(jpegPath);
    if (image) {
      // Fit inside the canvas preserving aspect ratio; never stretch.
      const scale = Math.min(geometry.width / image.width, geometry.height / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      const offsetX = (geometry.width - w) / 2;
      const offsetY = (geometry.height - h) / 2;
      ctx.drawImage(image, offsetX, offsetY, w, h);
      // Recorded, not recomputed by the caller: the cursor has to use the
      // exact fit the page was drawn with.
      this.fit = { scale, offsetX, offsetY };
    }
  }

  readPixels(): Buffer {
    return Buffer.from(this.canvas.data());
  }

  async render(jpegPath: string | null): Promise<Buffer> {
    await this.compose(jpegPath);
    return this.readPixels();
  }

  dispose(): void {
    this.cachedPath = null;
    this.cachedImage = null;
  }
}

/**
 * Compose a browser frame together with its cursor overlay.
 *
 * Every render path MUST go through this. Phase 3a shipped with the
 * composed path calling `compose()` directly and silently losing the
 * cursor, because drawing it lived only in the single-session path.
 * Keeping the two steps welded together is what prevents that.
 */
export async function composeBrowserWithCursor(
  renderer: BrowserFrameRenderer,
  jpegPath: string | null,
  pointers: readonly CursorKeyframe[],
  tSec: number,
  zoomTrack: readonly ZoomKeyframe[] = [],
  cursorSize = 1,
  motionBlur = false,
): Promise<void> {
  await renderer.compose(jpegPath);
  const cursor = cursorAt([...pointers], tSec);
  if (!cursor) return;
  // Keyframes are CSS pixels. Two things move them: an in-browser page
  // scale, and how the page was fitted onto this surface.
  const fit = renderer.pageFit;
  const scale = scaleAt(zoomTrack, tSec) * fit.scale;
  const scaled = (p: { x: number; y: number }) => ({
    x: fit.offsetX + p.x * scale,
    y: fit.offsetY + p.y * scale,
  });

  // Sample the same curve slightly in the past; if the cursor is still,
  // these coincide and the trail is invisible.
  const trail = motionBlur
    ? [0.06, 0.03]
        .map((back) => cursorAt([...pointers], tSec - back))
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => scaled(c.at))
    : [];

  drawCursor(renderer.context, scaled(cursor.at), {
    clickAge: cursor.clickAge,
    // Scale with the page too, or supersampling shrinks the cursor by
    // the zoom factor once the camera crops back down.
    size: 18 * cursorSize * scale,
    trail,
  });
}
