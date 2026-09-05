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
  bounds?: Rect,
): Rect {
  const z = Math.max(1, zoom);
  const width = surface.width / z;
  const height = surface.height / z;

  // Without bounds the whole surface is fair game. With them — the window
  // interior, inside the presentation padding — zooming moves INTO the
  // screen instead of magnifying the frame around it. At 1.7x an unbounded
  // camera turns a 56px padding band into a 95px one, which reads as a
  // mistake rather than as a zoom.
  const b = bounds ?? { x: 0, y: 0, width: surface.width, height: surface.height };
  const cx = focus ? focus.x + focus.width / 2 : b.x + b.width / 2;
  const cy = focus ? focus.y + focus.height / 2 : b.y + b.height / 2;

  return {
    x: clampAxis(cx, width, b.x, b.width, surface.width),
    y: clampAxis(cy, height, b.y, b.height, surface.height),
    width,
    height,
  };
}

/**
 * Where one axis of the camera sits.
 *
 * Continuous across the point where the camera first fits inside the
 * bounds: at exactly that size the two branches agree, so a ramping zoom
 * never snaps as it crosses over.
 */
function clampAxis(
  center: number,
  size: number,
  boundStart: number,
  boundSize: number,
  surfaceSize: number,
): number {
  const want =
    size <= boundSize
      ? Math.max(boundStart, Math.min(center - size / 2, boundStart + boundSize - size))
      : // Too wide to fit within the bounds; the widest honest framing is
        // the bounds centred, which is also what the branch above gives
        // as size approaches boundSize.
        boundStart + (boundSize - size) / 2;
  // The surface is still the hard limit: past it there are no pixels.
  return Math.max(0, Math.min(want, surfaceSize - size));
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
