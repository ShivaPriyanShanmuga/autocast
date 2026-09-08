import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  outputPath: string;
  /** A wav to mux in as the audio track. Omitted leaves the video mute. */
  audioPath?: string;
}

export interface EncodeResult {
  frames: number;
}

/**
 * Stream RGBA frames into ffmpeg. Frames are written as they arrive and
 * never accumulated: spec section 13 requires no full-video buffering.
 */
export async function encodeFrames(
  frames: AsyncIterable<Buffer>,
  opts: EncodeOptions,
): Promise<EncodeResult> {
  await mkdir(dirname(opts.outputPath), { recursive: true });

  const expected = opts.width * opts.height * 4;

  // Video still streams through stdin; audio is a second input read from
  // disk. `-shortest` keeps a stray millisecond of audio from extending
  // the file past its last frame.
  const audio = opts.audioPath;
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${opts.width}x${opts.height}`,
      '-r', String(opts.fps),
      '-i', 'pipe:0',
      ...(audio ? ['-i', audio] : []),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : []),
      '-movflags', '+faststart',
      opts.outputPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );

  let stderr = '';
  ff.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
  });

  // Set the moment ffmpeg is gone. Without this the frame loop keeps
  // writing into a dead stdin and blocks forever on a drain that will
  // never come — which is what an early ffmpeg failure looks like: a
  // hang, with the real error sitting unread in stderr.
  let exited = false;
  ff.on('close', () => {
    exited = true;
  });

  const finished = new Promise<void>((resolve, reject) => {
    ff.on('error', (e) =>
      reject(
        new Error(
          `could not run ffmpeg: ${e.message}. Run "autodemo doctor" for install instructions.`,
        ),
      ),
    );
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-800)}`)),
    );
  });

  // We only await `finished` on the success path. Without a handler here,
  // aborting would surface as an unhandled rejection and can terminate the
  // host process.
  finished.catch(() => undefined);

  // Swallow EPIPE: if ffmpeg dies early we want its exit message, not a
  // stream error that masks it.
  ff.stdin.on('error', () => undefined);

  /**
   * Kill ffmpeg and wait for it to actually exit. Waiting matters on
   * Windows, which keeps the output file locked until the process is gone
   * — a caller that deletes its output directory would otherwise hit
   * EPERM.
   */
  const abort = async (): Promise<void> => {
    ff.kill();
    if (ff.exitCode !== null || ff.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref();
      ff.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  let count = 0;
  try {
    for await (const frame of frames) {
      if (frame.length !== expected) {
        await abort();
        throw new Error(
          `frame ${count} is ${frame.length} bytes, expected ${expected} ` +
            `(${opts.width}x${opts.height} RGBA)`,
        );
      }
      if (exited) break;
      if (!ff.stdin.write(frame)) {
        // Race the drain against ffmpeg exiting, or a dead process
        // deadlocks the writer.
        await new Promise<void>((r) => {
          const done = (): void => {
            ff.stdin.off('drain', done);
            ff.off('close', done);
            r();
          };
          ff.stdin.once('drain', done);
          ff.once('close', done);
        });
      }
      count++;
    }
  } catch (error) {
    await abort();
    throw error;
  }

  if (exited) {
    // ffmpeg is already gone, so `finished` carries the real reason.
    await finished;
    throw new Error('ffmpeg exited before every frame was written');
  }

  if (count === 0) {
    await abort();
    throw new Error('no frames were produced, so there is nothing to encode');
  }

  ff.stdin.end();
  await finished;
  return { frames: count };
}

export interface VideoProbe {
  codec: string;
  width: number;
  height: number;
  frames: number;
  pixFmt: string;
  audioCodec: string | null;
}

export async function probeVideo(path: string): Promise<VideoProbe> {
  const video = await probeVideoStream(path);
  // The video probe selects v:0 and so can never see an audio stream;
  // asking separately is what stops "has audio" being unanswerable.
  let audioCodec: string | null = null;
  try {
    const { probeAudio } = await import('../voice/probe.js');
    audioCodec = (await probeAudio(path)).codec;
  } catch {
    audioCodec = null;
  }
  return { ...video, audioCodec };
}

async function probeVideoStream(path: string): Promise<Omit<VideoProbe, 'audioCodec'>> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,nb_frames,pix_fmt',
        '-of', 'default=nw=1',
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    let out = '';
    p.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      const field = (name: string): string =>
        new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
      resolve({
        codec: field('codec_name'),
        width: Number(field('width')),
        height: Number(field('height')),
        frames: Number(field('nb_frames')),
        pixFmt: field('pix_fmt'),
      });
    });
  });
}
