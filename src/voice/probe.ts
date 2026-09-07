import { spawn } from 'node:child_process';

export interface AudioProbe {
  codec: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
}

/**
 * Audio is verified through ffprobe, never by listening: spec section 3
 * keeps media out of agent context, and "is there a track, and how long
 * is it" are questions metadata answers exactly.
 */
export async function probeAudio(path: string): Promise<AudioProbe> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,duration,sample_rate,channels',
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
      if (code !== 0) return reject(new Error(`ffprobe exited ${code} for ${path}`));
      const field = (name: string): string =>
        new RegExp(`^${name}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
      const codec = field('codec_name');
      if (!codec) return reject(new Error(`no audio stream in ${path}`));
      resolve({
        codec,
        durationSec: Number(field('duration')),
        sampleRate: Number(field('sample_rate')),
        channels: Number(field('channels')),
      });
    });
  });
}
