import type { CellRect } from './find-in-screen.js';
import type { FrameGeometry } from './frame.js';
import type { ScreenState } from './screen.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A view onto a rendered surface.
 *
 * Zoom is expressed as a moving rectangle over a surface rendered ONCE at
 * a fixed supersampled size, rather than by re-rendering at a larger font
 * each frame. Two reasons:
 *
 *  - Smoothness. Re-rendering means rounding the font to whole pixels, so
 *    an animating zoom snaps 16px, 17px, 18px and the text visibly jerks.
 *    A rectangle moves in sub-pixel steps.
 *  - It generalises. Panning, and later following the mouse, are just the
 *    rectangle moving — not a separate mechanism that has to fight the
 *    cropping one.
 */
export function cameraRect(
  surface: { width: number; height: number },
  focus: Rect | null,
  zoom: number,
): Rect {
  const z = Math.max(1, zoom);
  const width = surface.width / z;
  const height = surface.height / z;

  if (focus === null || z === 1) {
    return { x: (surface.width - width) / 2, y: (surface.height - height) / 2, width, height };
  }

  const cx = focus.x + focus.width / 2;
  const cy = focus.y + focus.height / 2;

  // Clamp so the camera never leaves the surface, which would show
  // background where content should be.
  const x = Math.max(0, Math.min(cx - width / 2, surface.width - width));
  const y = Math.max(0, Math.min(cy - height / 2, surface.height - height));
  return { x, y, width, height };
}

/** Where a cell region sits in the rendered surface, in pixels. */
export function cellRectToPixels(
  geometry: FrameGeometry,
  screen: ScreenState,
  cell: CellRect,
): Rect {
  const usableW = geometry.width - geometry.padding * 2;
  const usableH = geometry.height - geometry.padding * 2;
  const cellW = usableW / Math.max(1, screen.cols);
  const cellH = usableH / Math.max(1, screen.rows);

  return {
    x: geometry.padding + cell.col * cellW,
    y: geometry.padding + cell.row * cellH,
    width: Math.max(cellW, cell.width * cellW),
    height: Math.max(cellH, cell.height * cellH),
  };
}
