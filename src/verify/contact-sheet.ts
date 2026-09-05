import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCanvas, ImageData } from '@napi-rs/canvas';

const MAX_TILES = 6;
const COLUMNS = 3;
const GAP = 8;

/**
 * Tile sample frames from a failed run into one PNG.
 *
 * This is the human-gated escape hatch of spec section 3 constraint 2:
 * the path is printed, and NOTHING in this codebase ever reads the file
 * back. An agent may open it only when a human explicitly asks — that is
 * what keeps the authoring loop free of frames.
 */
export async function writeContactSheet(
  path: string,
  frames: readonly Buffer[],
  size: { width: number; height: number },
): Promise<string> {
  const picked = pickEvenly(frames, MAX_TILES);
  const cols = Math.min(COLUMNS, Math.max(1, picked.length));
  const rows = Math.max(1, Math.ceil(picked.length / cols));

  const canvas = createCanvas(
    cols * size.width + (cols + 1) * GAP,
    rows * size.height + (rows + 1) * GAP,
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  picked.forEach((frame, i) => {
    const tile = createCanvas(size.width, size.height);
    tile
      .getContext('2d')
      .putImageData(new ImageData(new Uint8ClampedArray(frame), size.width, size.height), 0, 0);
    const col = i % cols;
    const row = Math.floor(i / cols);
    ctx.drawImage(tile, GAP + col * (size.width + GAP), GAP + row * (size.height + GAP));
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canvas.toBuffer('image/png'));
  return path;
}

/** Spread picks across the whole run rather than taking the first N. */
function pickEvenly<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]!);
}
