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
      ctx.drawImage(image, (geometry.width - w) / 2, (geometry.height - h) / 2, w, h);
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
  // Keyframes are CSS pixels. Once the page is scaled, the same element
  // sits somewhere else on screen, so the pointer must scale with it.
  const scale = scaleAt(zoomTrack, tSec);
  const scaled = (p: { x: number; y: number }) => ({ x: p.x * scale, y: p.y * scale });

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
    size: 18 * cursorSize,
    trail,
  });
}
