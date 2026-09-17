import { describe, it, expect } from 'vitest';
import { CameraFollower, DEAD_ZONE_FRACTION, FOLLOW_HALF_LIFE_SEC } from './follow.js';

const FRAME = 1 / 30;

describe('CameraFollower', () => {
  it('starts exactly where it is told to, with no drift-in', () => {
    const f = new CameraFollower({ x: 100, y: 200 }, { width: 1280, height: 720 });
    expect(f.position).toEqual({ x: 100, y: 200 });
  });

  it('ignores small movements, so a resting cursor does not jitter the frame', () => {
    // A cursor that twitches a few pixels must not drag the whole frame
    // with it. This is the difference between a camera and a shake.
    const f = new CameraFollower({ x: 640, y: 360 }, { width: 1280, height: 720 });
    for (let i = 0; i < 30; i++) f.update({ x: 640 + (i % 2 ? 3 : -3), y: 360 }, FRAME);
    expect(f.position.x).toBeCloseTo(640, 1);
    expect(f.position.y).toBeCloseTo(360, 1);
  });

  it('follows a real move, but lags rather than snapping', () => {
    const f = new CameraFollower({ x: 200, y: 200 }, { width: 1280, height: 720 });
    const after1 = { ...f.update({ x: 900, y: 200 }, FRAME) };
    expect(after1.x).toBeGreaterThan(200);
    // One frame must not close most of a 700px gap.
    expect(after1.x).toBeLessThan(200 + 700 * 0.25);
  });

  it('settles, rather than easing forever', () => {
    // It comes to rest with the target just inside the dead zone, NOT
    // centred. Centring would mean moving again on the next twitch,
    // which is the jitter the dead zone exists to prevent.
    const frame = { width: 1280, height: 720 };
    const f = new CameraFollower({ x: 200, y: 200 }, frame);
    for (let i = 0; i < 120; i++) f.update({ x: 900, y: 500 }, FRAME);

    expect(Math.abs(900 - f.position.x)).toBeLessThanOrEqual(
      frame.width * DEAD_ZONE_FRACTION + 0.5,
    );
    expect(Math.abs(500 - f.position.y)).toBeLessThanOrEqual(
      frame.height * DEAD_ZONE_FRACTION + 0.5,
    );

    // And it is genuinely at rest: another hundred frames move nothing.
    const settled = f.position.x;
    for (let i = 0; i < 100; i++) f.update({ x: 900, y: 500 }, FRAME);
    expect(f.position.x).toBe(settled);
  });

  it('halves the remaining distance in about the stated half-life', () => {
    const f = new CameraFollower({ x: 0, y: 0 }, { width: 1280, height: 720 });
    const steps = Math.round(FOLLOW_HALF_LIFE_SEC / FRAME);
    for (let i = 0; i < steps; i++) f.update({ x: 1000, y: 0 }, FRAME);
    expect(f.position.x).toBeGreaterThan(400);
    expect(f.position.x).toBeLessThan(600);
  });

  it('moves the same distance whatever the frame rate', () => {
    // Damping done per FRAME rather than per second would make a 60fps
    // render track twice as fast as a 30fps one.
    const at30 = new CameraFollower({ x: 0, y: 0 }, { width: 1280, height: 720 });
    for (let i = 0; i < 30; i++) at30.update({ x: 1000, y: 0 }, 1 / 30);
    const at60 = new CameraFollower({ x: 0, y: 0 }, { width: 1280, height: 720 });
    for (let i = 0; i < 60; i++) at60.update({ x: 1000, y: 0 }, 1 / 60);
    expect(at30.position.x).toBeCloseTo(at60.position.x, 0);
  });

  it('exposes a dead zone proportional to the frame, not a fixed pixel count', () => {
    // 20px is generous on a phone and invisible at 4K.
    expect(DEAD_ZONE_FRACTION).toBeGreaterThan(0);
    expect(DEAD_ZONE_FRACTION).toBeLessThan(0.2);
  });

  it('survives a zero or negative timestep', () => {
    const f = new CameraFollower({ x: 10, y: 10 }, { width: 1280, height: 720 });
    f.update({ x: 900, y: 900 }, 0);
    f.update({ x: 900, y: 900 }, -1);
    expect(Number.isFinite(f.position.x)).toBe(true);
    expect(Number.isFinite(f.position.y)).toBe(true);
  });
});
