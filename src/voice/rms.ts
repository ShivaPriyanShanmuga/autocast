import { readFile } from 'node:fs/promises';

/**
 * Mean energy in a window of a mono 16-bit wav.
 *
 * Audio is checked as a number, never by listening: spec section 3 keeps
 * media out of agent context, and "is there sound here" is exactly what
 * RMS answers.
 */
export async function rmsAt(
  path: string,
  fromSec: number,
  toSec: number,
  sampleRate = 24_000,
): Promise<number> {
  const buf = await readFile(path);
  // Walk the RIFF chunks rather than assuming a 44-byte header; ffmpeg
  // writes a LIST chunk that would otherwise be read as samples.
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error(`no data chunk in ${path}`);

  const total = Math.min(dataLen / 2, (buf.length - dataOff) / 2);
  const start = Math.max(0, Math.floor(fromSec * sampleRate));
  const end = Math.min(total, Math.floor(toSec * sampleRate));
  if (end <= start) return 0;

  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = buf.readInt16LE(dataOff + i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / (end - start));
}
