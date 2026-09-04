/** [seconds since start, "o" for output, data] — asciicast v2. */
export type CastEvent = [number, 'o', string];

export interface CastLog {
  version: 2;
  width: number;
  height: number;
  /** Unix seconds when recording began. */
  timestamp: number;
  events: CastEvent[];
}

/**
 * Accumulates the PTY byte stream with timestamps. This IS the semantic
 * log of spec section 4.2 — kilobytes of text that can be replayed to
 * frames offline at any resolution, theme or speed.
 */
export class CastRecorder {
  private readonly startedAt: number;
  private readonly events: CastEvent[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
  }

  record(data: string): void {
    const seconds = (this.now() - this.startedAt) / 1000;
    this.events.push([Number(seconds.toFixed(6)), 'o', data]);
  }

  log(): CastLog {
    return {
      version: 2,
      width: this.width,
      height: this.height,
      timestamp: Math.floor(this.startedAt / 1000),
      events: [...this.events],
    };
  }

  toJsonl(): string {
    const log = this.log();
    const header = JSON.stringify({
      version: log.version,
      width: log.width,
      height: log.height,
      timestamp: log.timestamp,
    });
    return [header, ...log.events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  }
}

export function parseJsonl(text: string): CastLog {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const [headerLine, ...eventLines] = lines;
  if (headerLine === undefined) throw new Error('empty asciicast');

  const header = JSON.parse(headerLine) as Omit<CastLog, 'events'>;
  return {
    version: 2,
    width: header.width,
    height: header.height,
    timestamp: header.timestamp,
    events: eventLines.map((l) => JSON.parse(l) as CastEvent),
  };
}
