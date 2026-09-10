import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Refuse an unusable output path BEFORE capturing anything.
 *
 * Capture is the expensive half of a render — seconds for a terminal
 * demo, most of a minute for the flagship — and until this existed the
 * output path was not touched until the encoder ran, so a demo would do
 * all of that work and then die because its destination was a directory.
 * The error came back as a raw ffmpeg exit code, which named neither the
 * path nor the field that set it.
 *
 * Deliberately does NOT delete an existing video here. A failed capture
 * should leave the previous one alone; removing it is the render's job,
 * once it knows the run actually failed.
 */
export async function checkOutputPath(outputPath: string): Promise<void> {
  const parent = dirname(outputPath);

  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    throw new Error(
      `cannot write to ${outputPath}: its directory could not be created ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Check output.path in the demo script.',
    );
  }

  try {
    const info = await stat(outputPath);
    if (info.isDirectory()) {
      throw new Error(
        `cannot write to ${outputPath}: a directory already exists there. ` +
          'Set output.path to a file name, or move the directory out of the way.',
      );
    }
  } catch (error) {
    // Not existing is the normal case, and the only one we ignore.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * A short, stable id for "this render", derived from where its video goes.
 *
 * Renders share a working directory, and several of the paths they write
 * to were fixed: the frames root and the built audio track. Two renders
 * at once therefore fought over them — one deleting the other's frames
 * mid-capture, or overwriting its track so the wrong narration ended up
 * in the wrong video, silently.
 *
 * Keyed on the OUTPUT path rather than a random id on purpose. Two runs
 * producing the same video are the same run as far as intermediates go,
 * so re-rendering still reclaims its own leftovers; two runs producing
 * different videos never touch each other's.
 */
export function runKey(outputPath: string): string {
  return createHash('sha256').update(resolve(outputPath)).digest('hex').slice(0, 12);
}
