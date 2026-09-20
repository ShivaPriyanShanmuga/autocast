export interface Point {
  x: number;
  y: number;
}

/**
 * How far the cursor may stray before the camera bothers to move, as a
 * fraction of the frame.
 *
 * A fraction rather than a pixel count: 20px is a generous margin on a
 * small canvas and invisible at 4K, and this tool renders both.
 */
export const DEAD_ZONE_FRACTION = 0.08;

/**
 * Time for the camera to close half the remaining distance.
 *
 * Long enough that the camera reads as following rather than being
 * dragged; short enough that it arrives before the viewer wonders why
 * they are looking at the wrong thing.
 */
export const FOLLOW_HALF_LIFE_SEC = 0.35;

/** Below this, stop easing and land — an exponential never quite arrives. */
const SNAP_PX = 0.5;

/**
 * A camera that follows a moving target without chasing it.
 *
 * Two behaviours, and both matter. A DEAD ZONE, so a cursor jittering a
 * few pixels while at rest does not drag the whole frame around — that
 * is the difference between a camera move and a shake. And EXPONENTIAL
 * DAMPING, so a real move is followed with a lag: the frame trails the
 * cursor and settles, rather than snapping to it.
 *
 * Damping is per second, not per frame. Doing it per frame would make a
 * 60fps render track twice as fast as a 30fps one, which would make the
 * output depend on a setting that is supposed to affect only smoothness.
 */
export class CameraFollower {
  private at: Point;

  constructor(
    start: Point,
    private readonly frame: { width: number; height: number },
  ) {
    this.at = { x: start.x, y: start.y };
  }

  get position(): Point {
    return { x: this.at.x, y: this.at.y };
  }

  update(target: Point, dtSec: number): Point {
    if (!(dtSec > 0) || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      return this.position;
    }

    const dx = target.x - this.at.x;
    const dy = target.y - this.at.y;

    // Inside the dead zone the camera holds still, whatever the cursor
    // is doing.
    const slackX = this.frame.width * DEAD_ZONE_FRACTION;
    const slackY = this.frame.height * DEAD_ZONE_FRACTION;
    if (Math.abs(dx) <= slackX && Math.abs(dy) <= slackY) return this.position;

    // Aim at the edge of the dead zone rather than the cursor itself, so
    // the camera stops as soon as the cursor is comfortably framed
    // instead of centring it and then having to move again.
    const wantX = target.x - Math.sign(dx) * Math.min(Math.abs(dx), slackX);
    const wantY = target.y - Math.sign(dy) * Math.min(Math.abs(dy), slackY);

    const keep = Math.pow(0.5, dtSec / FOLLOW_HALF_LIFE_SEC);
    this.at = {
      x: wantX + (this.at.x - wantX) * keep,
      y: wantY + (this.at.y - wantY) * keep,
    };

    if (Math.abs(wantX - this.at.x) < SNAP_PX) this.at.x = wantX;
    if (Math.abs(wantY - this.at.y) < SNAP_PX) this.at.y = wantY;

    return this.position;
  }
}
