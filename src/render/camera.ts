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

  // The surface is the only limit. An earlier version also clamped the
  // camera inside the window, to keep the presentation background out of
  // frame while zoomed. That was the wrong goal and it showed: the extra
  // constraint swung the camera around as the zoom ramped, so the move
  // bounced, and framing a line near an edge shoved the view sideways and
  // clipped content. Zooming means scaling the plane about a point. If
  // some background comes along with it, that is what zooming into a
  // screen looks like.
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

/**
 * Where a CSS-pixel box on the page sits in the rendered surface.
 *
 * The browser's answer to `cellRectToPixels`. Both exist so the camera
 * never has to know which kind of backend it is looking at — a terminal
 * pattern and a DOM selector both reduce to a rectangle on a surface.
 *
 * MUST mirror how BrowserFrameRenderer fits the page: scaled to fit and
 * centred, never stretched. A different fit here would frame the camera
 * on empty background.
 */
export function browserRectToPixels(
  surface: { width: number; height: number },
  viewport: { width: number; height: number },
  box: Rect,
): Rect {
  const scale = Math.min(surface.width / viewport.width, surface.height / viewport.height);
  const offsetX = (surface.width - viewport.width * scale) / 2;
  const offsetY = (surface.height - viewport.height * scale) / 2;
  return {
    x: offsetX + box.x * scale,
    y: offsetY + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

/**
 * The camera partway through a zoom.
 *
 * Interpolates the whole RECT from the full frame to the final framing,
 * rather than asking `cameraRect` for a clamped rect at each intermediate
 * zoom. That difference is the whole point.
 *
 * Clamping per frame makes the camera slide into a corner on its way in,
 * because the clamp releases on each axis at a different zoom level. On
 * the shipped flagship that read as the background disappearing off the
 * right and bottom together, the top collapsing a third of a second
 * later, and the left band GROWING from 56px to 95px — a wobble, not a
 * zoom. Interpolating the rect moves all four edges by the same fraction
 * of their travel on every frame, which is what reads as smooth.
 *
 * `zoom` may exceed `target`, because the spring overshoots and settles;
 * the rect simply carries a little past its mark, which is the point of
 * a spring.
 */
export function zoomedCamera(
  surface: { width: number; height: number },
  focus: Rect | null,
  zoom: number,
  target: number,
): Rect {
  const full = { x: 0, y: 0, width: surface.width, height: surface.height };
  if (focus === null || target <= 1) return full;

  const progress = (zoom - 1) / (target - 1);
  if (progress <= 0) return full;

  const end = cameraRect(surface, focus, target);
  const at = (from: number, to: number): number => from + (to - from) * progress;

  const width = Math.max(1, at(full.width, end.width));
  const height = Math.max(1, at(full.height, end.height));
  // `end` is already inside the surface and progress is positive, so an
  // overshoot moves the rect further in, never off the edge.
  return {
    x: Math.max(0, Math.min(at(full.x, end.x), surface.width - width)),
    y: Math.max(0, Math.min(at(full.y, end.y), surface.height - height)),
    width,
    height,
  };
}
