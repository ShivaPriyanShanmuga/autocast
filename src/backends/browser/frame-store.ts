import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StoredFrame {
  path: string;
  /** Unix seconds as a float, exactly as CDP reported it. */
  tSec: number;
}

export interface FrameManifest {
  dir: string;
  width: number;
  height: number;
  frames: StoredFrame[];
}

/**
 * Frames are written to disk as they arrive and never accumulated in
 * memory (spec section 13). The timestamps are the record of time: the
 * screencast is change-driven, so frame COUNT says nothing about
 * duration (spec section 4.5.1).
 */
export class FrameStore {
  private readonly frames: StoredFrame[] = [];
  private ready: Promise<void> | undefined;

  constructor(private readonly dir: string) {}

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  async add(base64Jpeg: string, tSec: number): Promise<void> {
    await this.ensureDir();
    const path = join(this.dir, `${String(this.frames.length).padStart(6, '0')}.jpg`);
    await writeFile(path, Buffer.from(base64Jpeg, 'base64'));
    this.frames.push({ path, tSec });
  }

  get count(): number {
    return this.frames.length;
  }

  manifest(width: number, height: number): FrameManifest {
    return { dir: this.dir, width, height, frames: [...this.frames] };
  }

  /** Debugging aid; geometry comes from the caller that knows it. */
  async writeManifest(width = 0, height = 0): Promise<string> {
    await this.ensureDir();
    const path = join(this.dir, 'manifest.json');
    await writeFile(path, JSON.stringify(this.manifest(width, height), null, 2));
    return path;
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Rebase absolute unix seconds so the first frame sits at t=0. */
export function relativeTimeline(manifest: FrameManifest): StoredFrame[] {
  const first = manifest.frames[0];
  if (!first) return [];
  return manifest.frames.map((f) => ({ ...f, tSec: f.tSec - first.tSec }));
}
