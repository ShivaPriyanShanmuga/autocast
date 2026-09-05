import { describe, it, expect } from 'vitest';
import { CastRecorder, parseJsonl } from './cast.js';

function fakeClock(times: number[]) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

describe('CastRecorder', () => {
  it('records events with seconds elapsed since start', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 500, 1500]));
    r.record('a');
    r.record('b');
    const log = r.log();
    expect(log.events[0]![0]).toBeCloseTo(0.5, 3);
    expect(log.events[1]![0]).toBeCloseTo(1.5, 3);
  });

  it('carries the terminal geometry', () => {
    const log = new CastRecorder(100, 28, fakeClock([0])).log();
    expect(log.width).toBe(100);
    expect(log.height).toBe(28);
    expect(log.version).toBe(2);
  });

  it('preserves escape sequences verbatim', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 10]));
    r.record('\x1b[32mgreen\x1b[0m');
    expect(r.log().events[0]![2]).toBe('\x1b[32mgreen\x1b[0m');
  });

  it('round-trips through asciicast v2 jsonl', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 100, 250]));
    r.record('one');
    r.record('\x1b[2Jtwo');
    expect(parseJsonl(r.toJsonl())).toEqual(r.log());
  });

  it('writes a header line then one line per event', () => {
    const r = new CastRecorder(80, 24, fakeClock([0, 100]));
    r.record('x');
    const lines = r.toJsonl().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: 2, width: 80, height: 24 });
    expect(JSON.parse(lines[1]!)[2]).toBe('x');
  });
});

describe('precise epoch', () => {
  it('records the start time in unfloored milliseconds', () => {
    const r = new CastRecorder(80, 24, fakeClock([1788570639123, 1788570639623]));
    r.record('x');
    expect(r.log().startedAtMs).toBe(1788570639123);
  });

  it('keeps the asciicast header timestamp in floored seconds', () => {
    const r = new CastRecorder(80, 24, fakeClock([1788570639123]));
    expect(r.log().timestamp).toBe(1788570639);
  });

  it('survives a jsonl round trip', () => {
    const r = new CastRecorder(80, 24, fakeClock([1788570639123, 1788570639456]));
    r.record('y');
    expect(parseJsonl(r.toJsonl()).startedAtMs).toBe(1788570639123);
  });

  it('is precise enough to place a scene within one frame at 30fps', () => {
    // The floored header would round 1788570639999 down to ...639000,
    // an error of 999ms — thirty frames at 30fps.
    const r = new CastRecorder(80, 24, fakeClock([1788570639999]));
    expect(r.log().startedAtMs % 1000).toBe(999);
  });
});
