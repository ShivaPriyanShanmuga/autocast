import type { SKRSContext2D } from '@napi-rs/canvas';
import { ensureFontRegistered, FONT_FAMILY } from './font.js';

/** Captions never exceed two lines; a third crowds the frame. */
export const MAX_LINES = 2;

/**
 * Break narration into caption lines.
 *
 * Truncation is marked with an ellipsis rather than silent: a caption
 * that simply stops leaves the viewer unable to tell it was cut. The
 * linter warns about narration this long (L007), so reaching the
 * ellipsis means a warning was ignored.
 */
export function wrapCaption(text: string, maxChars: number, maxLines = MAX_LINES): string[] {
  // Newlines would otherwise survive into a single "line" and break the
  // layout, since the caller measures line count, not glyphs.
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const width = Math.max(1, Math.floor(maxChars));
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    if (lines.length === maxLines) return truncate(lines, width);
    // A single word wider than the line still has to go somewhere;
    // placing it whole is better than hyphenating badly, and it must not
    // spin the loop.
    current = word;
  }
  if (current !== '') lines.push(current);
  if (lines.length > maxLines) return truncate(lines, width);
  return lines;
}

function truncate(lines: string[], width: number): string[] {
  const kept = lines.slice(0, MAX_LINES);
  const last = kept[kept.length - 1] ?? '';
  const room = Math.max(1, width - 1);
  kept[kept.length - 1] = `${last.length > room ? last.slice(0, room) : last}…`;
  return kept;
}

export interface CaptionStyle {
  fontPx: number;
  /** Space between the text and the edge of the scrim. */
  padding: number;
  radius: number;
  /** Fraction of the frame height left below the scrim. */
  bottomMargin: number;
  /** Scrim opacity. */
  opacity: number;
}

const DEFAULT_STYLE: CaptionStyle = {
  fontPx: 26,
  padding: 18,
  radius: 12,
  bottomMargin: 0.06,
  opacity: 0.72,
};

/**
 * How many characters fit on a caption line at this frame width.
 *
 * Exposed so the caller wraps to the same width the drawing will use;
 * wrapping to a guess and drawing to a measurement is how captions end
 * up clipped.
 */
export function captionLineChars(frameWidth: number, fontPx = DEFAULT_STYLE.fontPx): number {
  // JetBrains Mono advances 0.6 em. The scrim is inset a tenth of the
  // frame on each side, and the padding sits inside that.
  const usable = frameWidth * 0.8 - DEFAULT_STYLE.padding * 2;
  return Math.max(8, Math.floor(usable / (fontPx * 0.6)));
}

/**
 * Draw a caption over the finished frame.
 *
 * A scrim rather than outlined text, because our demos cut between a
 * near-black terminal and a white page and the caption has to stay
 * legible over both. The scrim darkens one and lightens the other, so
 * there is always contrast behind the glyphs.
 *
 * MUST be called after the zoom camera: inside it, the caption would
 * scale and crop along with the frame.
 */
export function drawCaption(
  ctx: SKRSContext2D,
  lines: readonly string[],
  frame: { width: number; height: number },
  style: Partial<CaptionStyle> = {},
): void {
  if (lines.length === 0) return;
  ensureFontRegistered();

  const s = { ...DEFAULT_STYLE, ...style };
  const lineHeight = Math.round(s.fontPx * 1.35);
  const textHeight = lineHeight * lines.length;
  const boxHeight = textHeight + s.padding * 2;

  ctx.save();
  ctx.font = `${s.fontPx}px "${FONT_FAMILY}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const boxWidth = Math.min(frame.width * 0.9, widest + s.padding * 2);
  const x = (frame.width - boxWidth) / 2;
  const y = frame.height - frame.height * s.bottomMargin - boxHeight;

  ctx.fillStyle = `rgba(12, 12, 18, ${s.opacity})`;
  roundedPath(ctx, x, y, boxWidth, boxHeight, s.radius);
  ctx.fill();

  ctx.fillStyle = '#f4f4f8';
  lines.forEach((line, i) => {
    ctx.fillText(line, frame.width / 2, y + s.padding + lineHeight * (i + 0.5));
  });
  ctx.restore();
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
