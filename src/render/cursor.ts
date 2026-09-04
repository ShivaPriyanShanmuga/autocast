import type { SKRSContext2D } from '@napi-rs/canvas';

export interface CursorPoint {
  x: number;
  y: number;
}

export interface CursorKeyframe {
  tSec: number;
  at: CursorPoint;
  click?: boolean;
}

/**
 * Minimum-jerk easing: the velocity profile a human arm actually makes.
 * Linear interpolation is what reads as robotic (spec section 7.2).
 */
export function minimumJerk(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

/** How long a click pulse stays visible. */
const CLICK_PULSE_SEC = 0.35;
/** Default time taken to travel between two keyframes. */
const DEFAULT_TRAVEL_SEC = 0.45;

export function cursorAt(
  keyframes: CursorKeyframe[],
  tSec: number,
  travelSec: number = DEFAULT_TRAVEL_SEC,
): { at: CursorPoint; clickAge: number | null } | null {
  if (keyframes.length === 0) return null;
  const first = keyframes[0]!;
  if (tSec < first.tSec) return null;

  let from = first;
  let to: CursorKeyframe | null = null;
  for (const k of keyframes) {
    if (k.tSec <= tSec) from = k;
    else {
      to = k;
      break;
    }
  }

  let at: CursorPoint = from.at;
  if (to) {
    // Arrive exactly at the keyframe time, having travelled for travelSec.
    const start = Math.max(from.tSec, to.tSec - travelSec);
    const span = Math.max(to.tSec - start, 1e-6);
    const p = minimumJerk((tSec - start) / span);
    at = {
      x: from.at.x + (to.at.x - from.at.x) * p,
      y: from.at.y + (to.at.y - from.at.y) * p,
    };
  }

  let clickAge: number | null = null;
  for (const k of keyframes) {
    if (!k.click || k.tSec > tSec) continue;
    const age = tSec - k.tSec;
    if (age <= CLICK_PULSE_SEC) clickAge = age;
  }

  return { at, clickAge };
}

export interface DrawCursorOptions {
  size?: number;
  clickAge?: number | null;
}

/**
 * A headless browser has no cursor, so we draw one. Compositor-side, so
 * it never perturbs the page under test (spec section 7.2).
 */
export function drawCursor(
  ctx: SKRSContext2D,
  at: CursorPoint,
  opts: DrawCursorOptions,
): void {
  const size = opts.size ?? 18;
  const { x, y } = at;

  ctx.save();

  if (opts.clickAge !== null && opts.clickAge !== undefined) {
    const p = Math.min(opts.clickAge / CLICK_PULSE_SEC, 1);
    ctx.beginPath();
    ctx.arc(x, y, size * (0.6 + p * 1.4), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(80, 140, 255, ${(1 - p) * 0.85})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Classic arrow, drawn with a light outline so it reads on any page.
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x + size * 0.29, y + size * 0.76);
  ctx.lineTo(x + size * 0.47, y + size * 1.15);
  ctx.lineTo(x + size * 0.62, y + size * 1.08);
  ctx.lineTo(x + size * 0.44, y + size * 0.69);
  ctx.lineTo(x + size * 0.72, y + size * 0.66);
  ctx.closePath();

  ctx.fillStyle = 'rgba(20, 20, 28, 0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.restore();
}
