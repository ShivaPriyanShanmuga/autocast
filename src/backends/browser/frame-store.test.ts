import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameStore, relativeTimeline } from './frame-store.js';

const dirs: string[] = [];
const newDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'autodemo-frames-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// A 1x1 JPEG, base64, so tests never need a real browser.
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('FrameStore', () => {
  it('writes each frame to disk as a numbered file', async () => {
    const dir = newDir();
    const store = new FrameStore(dir);
    await store.add(TINY_JPEG, 1000.5);
    await store.add(TINY_JPEG, 1000.7);

    const m = store.manifest(640, 400);
    expect(m.frames).toHaveLength(2);
    for (const f of m.frames) expect(existsSync(f.path)).toBe(true);
    expect(readFileSync(m.frames[0]!.path).length).toBeGreaterThan(0);
  });

  it('preserves timestamps exactly as given', async () => {
    const dir = newDir();
    const store = new FrameStore(dir);
    await store.add(TINY_JPEG, 1788551698.609511);
    expect(store.manifest(640, 400).frames[0]!.tSec).toBe(1788551698.609511);
  });

  it('records the geometry in the manifest', async () => {
    const store = new FrameStore(newDir());
    await store.add(TINY_JPEG, 1);
    const m = store.manifest(1280, 720);
    expect(m.width).toBe(1280);
    expect(m.height).toBe(720);
  });

  it('writes the manifest as readable json', async () => {
    const dir = newDir();
    const store = new FrameStore(dir);
    await store.add(TINY_JPEG, 5);
    const path = await store.writeManifest();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { frames: unknown[] };
    expect(parsed.frames).toHaveLength(1);
  });

  it('dispose removes the frame directory', async () => {
    const dir = newDir();
    const store = new FrameStore(dir);
    await store.add(TINY_JPEG, 1);
    await store.dispose();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('relativeTimeline', () => {
  it('rebases absolute unix seconds onto zero', () => {
    const rebased = relativeTimeline({
      dir: 'x',
      width: 1,
      height: 1,
      frames: [
        { path: 'a', tSec: 1788551698.5 },
        { path: 'b', tSec: 1788551699.0 },
        { path: 'c', tSec: 1788551700.25 },
      ],
    });
    expect(rebased[0]!.tSec).toBeCloseTo(0, 6);
    expect(rebased[1]!.tSec).toBeCloseTo(0.5, 6);
    expect(rebased[2]!.tSec).toBeCloseTo(1.75, 6);
  });

  it('returns an empty list unchanged', () => {
    expect(relativeTimeline({ dir: 'x', width: 1, height: 1, frames: [] })).toEqual([]);
  });
});
