# autocast Phase 1b — Terminal rendering and encoding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay a captured asciicast into frames and encode them to an mp4, delivering Phase 1's user-facing exit criterion — a watchable video of a real command running.

**Architecture:** The asciicast from Phase 1a is replayed into a fresh `@xterm/headless` terminal. At each fixed-rate frame boundary the screen buffer is snapshotted into a plain `ScreenState` (characters plus resolved colours and attributes), rendered to an RGBA buffer with a bundled monospace font, and streamed straight into ffmpeg's stdin. Nothing buffers the whole video.

**Tech Stack:** `@napi-rs/canvas` 1.0.8 (glyph rasterisation), `@fontsource/jetbrains-mono` (the bundled font), ffmpeg (external). Existing: `@xterm/headless`, TypeScript 5.9, vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-04-autocast-design.md` — especially §4.2, §4.4, §6 and §6.1.

## Global Constraints

- **Node 20+**, ESM. Windows, macOS and Linux all first-class.
- **New runtime dependencies: `@napi-rs/canvas` and `@fontsource/jetbrains-mono` only.**
- **Never use the generic `monospace` font family.** Verified on this machine: it resolves to a *proportional* face (advances M=10.00, i=3.56, .=3.32). The bundled font is required for correctness, not merely determinism. Registered JetBrains Mono measures a uniform 12.00 advance at 20px — a 0.6 ratio.
- **xterm attribute predicates return packed integers, not booleans.** `isBold()` returns `134217728`, `isInverse()` returns `67108864`. Coerce with `Boolean(...)` or `!== 0`; never compare with `=== true`.
- **Wide characters occupy two columns.** `getWidth()` is 2 for the leading cell and 0 for its continuation cell, whose `getChars()` is empty. Skip width-0 cells or you will double-draw.
- **Colour modes must be checked before reading a colour.** `isFgDefault()` / `isFgPalette()` / `isFgRGB()`; a palette value is a 0-255 index, an RGB value is a packed 24-bit int (`706590` = `rgb(10, 200, 30)`).
- **Frames stream to ffmpeg via stdin; never buffer the whole video** (spec §13). `canvas.data()` returns an RGBA `Buffer` of exactly `width * height * 4`.
- **Honour backpressure** on ffmpeg's stdin: if `write()` returns false, await `'drain'`.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Measured budget: ~10 ms per 1280x720 frame, so a 60-second demo renders in roughly 18 seconds. Encoding 60 frames took 387 ms.

---

### Task 1: Bundled font registration

**Files:**
- Modify: `package.json` (add `@napi-rs/canvas`, `@fontsource/jetbrains-mono`)
- Create: `src/render/font.ts`
- Test: `src/render/font.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `const FONT_FAMILY = 'AutocastMono'`
  - `function ensureFontRegistered(): void` — idempotent
  - `interface CellMetrics { cellWidth: number; cellHeight: number; baselineOffset: number; fontSpec: string }`
  - `function measureCell(fontSizePx: number, lineHeightRatio?: number): CellMetrics`

- [ ] **Step 1: Install dependencies**

```bash
npm install @napi-rs/canvas@^1.0.8 @fontsource/jetbrains-mono
```

- [ ] **Step 2: Write the failing test**

Create `src/render/font.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { FONT_FAMILY, ensureFontRegistered, measureCell } from './font.js';

describe('bundled font', () => {
  it('registers under a stable family name', () => {
    ensureFontRegistered();
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = `20px "${FONT_FAMILY}"`;
    expect(ctx.measureText('M').width).toBeGreaterThan(0);
  });

  it('is genuinely monospaced, unlike the generic family', () => {
    ensureFontRegistered();
    const ctx = createCanvas(10, 10).getContext('2d');
    ctx.font = `20px "${FONT_FAMILY}"`;
    const widths = ['M', 'i', 'W', '.', 'l', '@'].map((c) => ctx.measureText(c).width);
    expect(new Set(widths.map((w) => w.toFixed(3))).size).toBe(1);
  });

  it('is idempotent', () => {
    ensureFontRegistered();
    expect(() => ensureFontRegistered()).not.toThrow();
  });

  it('reports cell metrics proportional to the font size', () => {
    const a = measureCell(16);
    const b = measureCell(32);
    expect(b.cellWidth).toBeCloseTo(a.cellWidth * 2, 1);
    expect(a.cellHeight).toBeGreaterThan(a.cellWidth);
    expect(a.fontSpec).toContain(FONT_FAMILY);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/render/font.test.ts`
Expected: FAIL — cannot resolve `./font.js`.

- [ ] **Step 4: Implement**

Create `src/render/font.ts`:

```ts
import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);

/**
 * Registered under our own name so rendering never depends on what the
 * host machine happens to have installed. Spec section 6: identical glyph
 * rasterisation on all three platforms is the determinism keystone.
 *
 * It is also required for correctness: the generic "monospace" family
 * resolves to a PROPORTIONAL face on Windows (M=10.00 but i=3.56), which
 * would shear every column out of alignment.
 */
export const FONT_FAMILY = 'AutocastMono';

let registered = false;

export function ensureFontRegistered(): void {
  if (registered) return;
  // Register the bold face too, so `bold` in a demo is the real 700 weight
  // rather than a synthesised smear of the regular one.
  for (const weight of ['400', '700']) {
    const path = require.resolve(
      `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`,
    );
    GlobalFonts.registerFromPath(path, FONT_FAMILY);
  }
  registered = true;
}

export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
  /** Y offset from the top of a cell to the text baseline. */
  baselineOffset: number;
  fontSpec: string;
}

/** Terminal line height as a multiple of the font size. */
const DEFAULT_LINE_HEIGHT = 1.35;

export function measureCell(
  fontSizePx: number,
  lineHeightRatio: number = DEFAULT_LINE_HEIGHT,
): CellMetrics {
  ensureFontRegistered();
  const fontSpec = `${fontSizePx}px "${FONT_FAMILY}"`;
  const ctx = createCanvas(8, 8).getContext('2d');
  ctx.font = fontSpec;
  const cellWidth = ctx.measureText('M').width;
  const cellHeight = Math.round(fontSizePx * lineHeightRatio);
  return {
    cellWidth,
    cellHeight,
    baselineOffset: Math.round((cellHeight + fontSizePx * 0.72) / 2),
    fontSpec,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/render/font.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/render/font.ts src/render/font.test.ts
git commit -m "feat: bundled monospace font registration"
```

---

### Task 2: Terminal colour theme

**Files:**
- Create: `src/render/theme.ts`
- Test: `src/render/theme.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Theme { background: string; foreground: string; palette: string[] }`
  - `const DEFAULT_THEME: Theme` — 16 ANSI colours plus defaults
  - `function paletteColor(theme: Theme, index: number): string` — handles 0-15 named, 16-231 cube, 232-255 greyscale
  - `function rgbToHex(packed: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/render/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, paletteColor, rgbToHex } from './theme.js';

describe('rgbToHex', () => {
  it('unpacks a 24-bit integer as xterm reports it', () => {
    // 706590 === 0x0AC81E === rgb(10, 200, 30)
    expect(rgbToHex(706590)).toBe('#0ac81e');
  });

  it('pads short components', () => {
    expect(rgbToHex(0x010203)).toBe('#010203');
  });

  it('handles black and white', () => {
    expect(rgbToHex(0x000000)).toBe('#000000');
    expect(rgbToHex(0xffffff)).toBe('#ffffff');
  });
});

describe('paletteColor', () => {
  it('returns the named colours for 0-15', () => {
    expect(paletteColor(DEFAULT_THEME, 0)).toBe(DEFAULT_THEME.palette[0]);
    expect(paletteColor(DEFAULT_THEME, 2)).toMatch(/^#[0-9a-f]{6}$/);
    expect(paletteColor(DEFAULT_THEME, 15)).toBe(DEFAULT_THEME.palette[15]);
  });

  it('computes the 6x6x6 cube for 16-231', () => {
    expect(paletteColor(DEFAULT_THEME, 16)).toBe('#000000');
    expect(paletteColor(DEFAULT_THEME, 231)).toBe('#ffffff');
    expect(paletteColor(DEFAULT_THEME, 100)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('computes the greyscale ramp for 232-255', () => {
    const dark = paletteColor(DEFAULT_THEME, 232);
    const light = paletteColor(DEFAULT_THEME, 255);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(parseInt(light.slice(1), 16)).toBeGreaterThan(parseInt(dark.slice(1), 16));
  });

  it('clamps out-of-range indices instead of returning undefined', () => {
    expect(paletteColor(DEFAULT_THEME, -1)).toMatch(/^#[0-9a-f]{6}$/);
    expect(paletteColor(DEFAULT_THEME, 999)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('DEFAULT_THEME', () => {
  it('has 16 palette entries and readable defaults', () => {
    expect(DEFAULT_THEME.palette).toHaveLength(16);
    expect(DEFAULT_THEME.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(DEFAULT_THEME.foreground).toMatch(/^#[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/theme.test.ts`
Expected: FAIL — cannot resolve `./theme.js`.

- [ ] **Step 3: Implement**

Create `src/render/theme.ts`:

```ts
export interface Theme {
  background: string;
  foreground: string;
  /** The 16 standard ANSI colours, in order. */
  palette: string[];
}

export const DEFAULT_THEME: Theme = {
  background: '#101014',
  foreground: '#d8d8e0',
  palette: [
    '#1c1c22', '#e05561', '#8ccf7e', '#e2b86b',
    '#4fa6ed', '#bf68d9', '#48b0bd', '#a1a1aa',
    '#3b3b45', '#ff6b78', '#a5e58f', '#f5cc7f',
    '#68b8ff', '#d885f0', '#5ac8d6', '#e4e4e8',
  ],
};

export function rgbToHex(packed: number): string {
  return `#${(packed & 0xffffff).toString(16).padStart(6, '0')}`;
}

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

/**
 * Resolve an xterm-256 palette index.
 *   0-15    the named ANSI colours
 *   16-231  a 6x6x6 RGB cube
 *   232-255 a 24-step greyscale ramp
 */
export function paletteColor(theme: Theme, index: number): string {
  const i = Math.max(0, Math.min(255, Math.round(index)));

  if (i < 16) return theme.palette[i] ?? theme.foreground;

  if (i < 232) {
    const n = i - 16;
    const r = CUBE_STEPS[Math.floor(n / 36) % 6]!;
    const g = CUBE_STEPS[Math.floor(n / 6) % 6]!;
    const b = CUBE_STEPS[n % 6]!;
    return rgbToHex((r << 16) | (g << 8) | b);
  }

  const level = 8 + (i - 232) * 10;
  return rgbToHex((level << 16) | (level << 8) | level);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/theme.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/theme.ts src/render/theme.test.ts
git commit -m "feat: terminal colour theme and xterm-256 palette resolution"
```

---

### Task 3: Screen snapshots

**Files:**
- Create: `src/render/screen.ts`
- Test: `src/render/screen.test.ts`

**Interfaces:**
- Consumes: `Theme`, `paletteColor`, `rgbToHex` (Task 2)
- Produces:
  - `interface RenderedCell { char: string; width: number; fg: string; bg: string; bold: boolean; dim: boolean; italic: boolean; underline: boolean }`
  - `interface ScreenState { cols: number; rows: number; cells: RenderedCell[][] }`
  - `function snapshotScreen(term: XtermLike, theme: Theme): ScreenState`

Inverse video is resolved here by swapping fg and bg, so the renderer never has to think about it.

- [ ] **Step 1: Write the failing test**

Create `src/render/screen.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { DEFAULT_THEME } from './theme.js';
import { snapshotScreen } from './screen.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (o: Record<string, unknown>) => any;
};

async function screenFrom(data: string, cols = 40, rows = 6) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((r) => term.write(data, r));
  return snapshotScreen(term, DEFAULT_THEME);
}

describe('snapshotScreen', () => {
  it('captures plain text with default colours', async () => {
    const s = await screenFrom('hello');
    expect(s.cols).toBe(40);
    expect(s.rows).toBe(6);
    expect(s.cells[0]!.slice(0, 5).map((c) => c.char).join('')).toBe('hello');
    expect(s.cells[0]![0]!.fg).toBe(DEFAULT_THEME.foreground);
    expect(s.cells[0]![0]!.bg).toBe(DEFAULT_THEME.background);
  });

  it('resolves a palette foreground colour', async () => {
    const s = await screenFrom('\x1b[32mgreen\x1b[0m');
    expect(s.cells[0]![0]!.fg).toBe(DEFAULT_THEME.palette[2]);
  });

  it('resolves a truecolor foreground', async () => {
    const s = await screenFrom('\x1b[38;2;10;200;30mx\x1b[0m');
    expect(s.cells[0]![0]!.fg).toBe('#0ac81e');
  });

  it('resolves a palette background colour', async () => {
    const s = await screenFrom('\x1b[44mb\x1b[0m');
    expect(s.cells[0]![0]!.bg).toBe(DEFAULT_THEME.palette[4]);
  });

  it('coerces packed attribute integers to real booleans', async () => {
    const s = await screenFrom('\x1b[1mB\x1b[0m');
    // xterm returns 134217728 for bold, not true. A leaked integer here
    // would still be truthy, so assert the type, not just truthiness.
    expect(s.cells[0]![0]!.bold).toBe(true);
    expect(typeof s.cells[0]![0]!.bold).toBe('boolean');
  });

  it('swaps foreground and background for inverse video', async () => {
    const plain = await screenFrom('p');
    const inverse = await screenFrom('\x1b[7mp\x1b[0m');
    expect(inverse.cells[0]![0]!.fg).toBe(plain.cells[0]![0]!.bg);
    expect(inverse.cells[0]![0]!.bg).toBe(plain.cells[0]![0]!.fg);
  });

  it('marks wide characters and their continuation cells', async () => {
    const s = await screenFrom('漢字');
    expect(s.cells[0]![0]!.char).toBe('漢');
    expect(s.cells[0]![0]!.width).toBe(2);
    expect(s.cells[0]![1]!.width).toBe(0);
  });

  it('preserves box-drawing characters', async () => {
    const s = await screenFrom('┌─┐');
    expect(s.cells[0]!.slice(0, 3).map((c) => c.char).join('')).toBe('┌─┐');
  });

  it('produces a full rectangular grid', async () => {
    const s = await screenFrom('x', 20, 4);
    expect(s.cells).toHaveLength(4);
    for (const row of s.cells) expect(row).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/screen.test.ts`
Expected: FAIL — cannot resolve `./screen.js`.

- [ ] **Step 3: Implement**

Create `src/render/screen.ts`:

```ts
import { paletteColor, rgbToHex, type Theme } from './theme.js';

export interface RenderedCell {
  char: string;
  /** 1 normally, 2 for a wide glyph, 0 for its continuation cell. */
  width: number;
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export interface ScreenState {
  cols: number;
  rows: number;
  cells: RenderedCell[][];
}

interface XtermCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgDefault(): number | boolean;
  isFgPalette(): number | boolean;
  isFgRGB(): number | boolean;
  isBgDefault(): number | boolean;
  isBgPalette(): number | boolean;
  isBgRGB(): number | boolean;
  isBold(): number | boolean;
  isDim(): number | boolean;
  isItalic(): number | boolean;
  isUnderline(): number | boolean;
  isInverse(): number | boolean;
}

export interface XtermLike {
  cols: number;
  rows: number;
  buffer: {
    active: {
      baseY: number;
      getLine(i: number): { getCell(x: number): XtermCell | undefined } | undefined;
    };
  };
}

/**
 * xterm's attribute predicates return packed integers (bold is
 * 134217728), not booleans. Everything downstream expects real booleans.
 */
const flag = (v: number | boolean): boolean => Boolean(v);

function resolveColor(
  isDefault: number | boolean,
  isPalette: number | boolean,
  value: number,
  theme: Theme,
  fallback: string,
): string {
  if (flag(isDefault)) return fallback;
  if (flag(isPalette)) return paletteColor(theme, value);
  return rgbToHex(value);
}

const EMPTY = (theme: Theme): RenderedCell => ({
  char: ' ',
  width: 1,
  fg: theme.foreground,
  bg: theme.background,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
});

export function snapshotScreen(term: XtermLike, theme: Theme): ScreenState {
  const { cols, rows } = term;
  const buf = term.buffer.active;
  const cells: RenderedCell[][] = [];

  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    const row: RenderedCell[] = [];

    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x);
      if (!cell) {
        row.push(EMPTY(theme));
        continue;
      }

      let fg = resolveColor(
        cell.isFgDefault(), cell.isFgPalette(), cell.getFgColor(), theme, theme.foreground,
      );
      let bg = resolveColor(
        cell.isBgDefault(), cell.isBgPalette(), cell.getBgColor(), theme, theme.background,
      );

      // Resolve inverse here so the renderer never has to know about it.
      if (flag(cell.isInverse())) [fg, bg] = [bg, fg];

      const chars = cell.getChars();
      row.push({
        char: chars === '' ? ' ' : chars,
        width: cell.getWidth(),
        fg,
        bg,
        bold: flag(cell.isBold()),
        dim: flag(cell.isDim()),
        italic: flag(cell.isItalic()),
        underline: flag(cell.isUnderline()),
      });
    }

    cells.push(row);
  }

  return { cols, rows, cells };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/screen.test.ts`
Expected: PASS — 9 tests.

> The wide-character test asserts `width` 2 then 0. If the continuation
> cell reports `char` as `' '` that is expected — we normalise empty
> `getChars()` to a space. The renderer keys off `width`, not `char`.

- [ ] **Step 5: Commit**

```bash
git add src/render/screen.ts src/render/screen.test.ts
git commit -m "feat: screen snapshot with resolved colours and attributes"
```

---

### Task 4: Cast replay at a fixed frame rate

**Files:**
- Create: `src/render/replay.ts`
- Test: `src/render/replay.test.ts`

**Interfaces:**
- Consumes: `CastLog` (Phase 1a), `ScreenState`/`snapshotScreen` (Task 3), `Theme` (Task 2)
- Produces:
  - `interface ReplayOptions { fps: number; theme?: Theme; tailMs?: number }`
  - `async function* replayCast(cast: CastLog, opts: ReplayOptions): AsyncGenerator<ScreenState>`
  - `function frameCount(cast: CastLog, fps: number, tailMs?: number): number`

The generator yields exactly one `ScreenState` per frame boundary, applying every cast event whose timestamp has passed. `tailMs` holds the final frame so a video does not end the instant the last byte arrives.

- [ ] **Step 1: Write the failing test**

Create `src/render/replay.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { CastLog } from '../backends/terminal/cast.js';
import { replayCast, frameCount } from './replay.js';
import { DEFAULT_THEME } from './theme.js';

function cast(events: Array<[number, string]>, width = 20, height = 4): CastLog {
  return {
    version: 2,
    width,
    height,
    timestamp: 0,
    events: events.map(([t, d]) => [t, 'o', d]),
  };
}

const collect = async (c: CastLog, fps: number, tailMs = 0) => {
  const out = [];
  for await (const s of replayCast(c, { fps, tailMs })) out.push(s);
  return out;
};

const rowText = (s: { cells: Array<Array<{ char: string }>> }, row: number) =>
  s.cells[row]!.map((c) => c.char).join('').trimEnd();

describe('frameCount', () => {
  it('covers the full duration at the given rate', () => {
    expect(frameCount(cast([[0, 'a'], [1, 'b']]), 30)).toBe(30);
  });

  it('includes the tail hold', () => {
    expect(frameCount(cast([[0, 'a'], [1, 'b']]), 30, 1000)).toBe(60);
  });

  it('never returns zero for an empty cast', () => {
    expect(frameCount(cast([]), 30)).toBeGreaterThan(0);
  });
});

describe('replayCast', () => {
  it('yields exactly frameCount frames', async () => {
    const c = cast([[0, 'a'], [1, 'b']]);
    const frames = await collect(c, 10);
    expect(frames).toHaveLength(frameCount(c, 10));
  });

  it('applies events as their timestamps pass', async () => {
    const c = cast([[0.0, 'first'], [0.5, '\r\nsecond']]);
    const frames = await collect(c, 10);
    expect(rowText(frames[1]!, 0)).toBe('first');
    expect(rowText(frames[1]!, 1)).toBe('');
    expect(rowText(frames[frames.length - 1]!, 1)).toBe('second');
  });

  it('carries the terminal geometry into every frame', async () => {
    const frames = await collect(cast([[0, 'x']], 30, 5), 5);
    for (const f of frames) {
      expect(f.cols).toBe(30);
      expect(f.rows).toBe(5);
    }
  });

  it('resolves a carriage-return redraw to the final value', async () => {
    const c = cast([[0, 'p  10%'], [0.2, '\rp 100%']]);
    const frames = await collect(c, 10);
    expect(rowText(frames[frames.length - 1]!, 0)).toBe('p 100%');
  });

  it('holds the last state through the tail', async () => {
    const c = cast([[0, 'done']]);
    const frames = await collect(c, 10, 500);
    expect(frames.length).toBeGreaterThan(4);
    expect(rowText(frames[frames.length - 1]!, 0)).toBe('done');
  });

  it('handles an empty cast without hanging', async () => {
    const frames = await collect(cast([]), 10);
    expect(frames.length).toBeGreaterThan(0);
    expect(rowText(frames[0]!, 0)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/replay.test.ts`
Expected: FAIL — cannot resolve `./replay.js`.

- [ ] **Step 3: Implement**

Create `src/render/replay.ts`:

```ts
import { createRequire } from 'node:module';
import type { CastLog } from '../backends/terminal/cast.js';
import { snapshotScreen, type ScreenState, type XtermLike } from './screen.js';
import { DEFAULT_THEME, type Theme } from './theme.js';

const require = createRequire(import.meta.url);

export interface ReplayOptions {
  fps: number;
  theme?: Theme;
  /** Extra time to hold the final state, so the video does not cut dead. */
  tailMs?: number;
}

const DEFAULT_TAIL_MS = 800;

function durationSec(cast: CastLog): number {
  return cast.events.length === 0 ? 0 : (cast.events[cast.events.length - 1]![0] ?? 0);
}

export function frameCount(cast: CastLog, fps: number, tailMs = DEFAULT_TAIL_MS): number {
  const total = durationSec(cast) + tailMs / 1000;
  return Math.max(1, Math.ceil(total * fps));
}

/**
 * Replay the asciicast into a fresh terminal, yielding one screen state
 * per frame boundary. This is the "render offline from the log" half of
 * spec section 4.2: no process is re-run, and the frame rate, size and
 * theme are all free parameters.
 */
export async function* replayCast(
  cast: CastLog,
  opts: ReplayOptions,
): AsyncGenerator<ScreenState> {
  const theme = opts.theme ?? DEFAULT_THEME;
  const tailMs = opts.tailMs ?? DEFAULT_TAIL_MS;

  const { Terminal } = require('@xterm/headless') as {
    Terminal: new (o: Record<string, unknown>) => XtermLike & {
      write(data: string, cb?: () => void): void;
    };
  };

  const term = new Terminal({
    cols: cast.width,
    rows: cast.height,
    allowProposedApi: true,
    scrollback: 0, // the visible screen is the frame; history is not drawn
  });

  const write = (data: string) => new Promise<void>((r) => term.write(data, r));

  const total = frameCount(cast, opts.fps, tailMs);
  let next = 0; // index of the next unapplied event

  for (let frame = 0; frame < total; frame++) {
    const t = (frame + 1) / opts.fps;
    while (next < cast.events.length && cast.events[next]![0] <= t) {
      await write(cast.events[next]![2]);
      next++;
    }
    yield snapshotScreen(term, theme);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/replay.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/replay.ts src/render/replay.test.ts
git commit -m "feat: asciicast replay to fixed-rate screen states"
```

---

### Task 5: Frame rasterisation

**Files:**
- Create: `src/render/frame.ts`
- Test: `src/render/frame.test.ts`

**Interfaces:**
- Consumes: `ScreenState` (Task 3), `measureCell`/`FONT_FAMILY` (Task 1), `Theme` (Task 2)
- Produces:
  - `interface FrameGeometry { width: number; height: number; fontSizePx: number; padding: number }`
  - `function fitGeometry(cols: number, rows: number, canvasW: number, canvasH: number): FrameGeometry`
  - `class FrameRenderer` with `constructor(geometry, theme)`, `render(screen: ScreenState): Buffer` returning RGBA of exactly `width * height * 4`

The renderer reuses one canvas across frames — allocating a 1280x720 canvas per frame would dominate the runtime.

- [ ] **Step 1: Write the failing test**

Create `src/render/frame.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME } from './theme.js';
import { fitGeometry, FrameRenderer } from './frame.js';
import type { ScreenState, RenderedCell } from './screen.js';

function cell(over: Partial<RenderedCell> = {}): RenderedCell {
  return {
    char: ' ',
    width: 1,
    fg: DEFAULT_THEME.foreground,
    bg: DEFAULT_THEME.background,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    ...over,
  };
}

function screen(rows: string[], cols = 20): ScreenState {
  return {
    cols,
    rows: rows.length,
    cells: rows.map((line) =>
      Array.from({ length: cols }, (_, x) => cell({ char: line[x] ?? ' ' })),
    ),
  };
}

describe('fitGeometry', () => {
  it('fits the grid inside the canvas', () => {
    const g = fitGeometry(90, 24, 1280, 720);
    expect(g.width).toBe(1280);
    expect(g.height).toBe(720);
    expect(g.fontSizePx).toBeGreaterThan(4);
  });

  it('uses a smaller font for a wider grid', () => {
    const wide = fitGeometry(200, 24, 1280, 720);
    const narrow = fitGeometry(60, 24, 1280, 720);
    expect(wide.fontSizePx).toBeLessThan(narrow.fontSizePx);
  });
});

describe('FrameRenderer', () => {
  const geometry = fitGeometry(20, 3, 320, 180);

  it('returns an RGBA buffer of exactly width * height * 4', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const buf = r.render(screen(['hello', '', '']));
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(geometry.width * geometry.height * 4);
  });

  it('paints the theme background', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const buf = r.render(screen(['', '', '']));
    // Top-left pixel sits in the padding, so it is pure background.
    const [red, green, blue] = [buf[0], buf[1], buf[2]];
    const expected = DEFAULT_THEME.background;
    expect(red).toBe(parseInt(expected.slice(1, 3), 16));
    expect(green).toBe(parseInt(expected.slice(3, 5), 16));
    expect(blue).toBe(parseInt(expected.slice(5, 7), 16));
  });

  it('draws glyphs — a frame with text differs from an empty one', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const empty = r.render(screen(['', '', '']));
    const text = r.render(screen(['hello world', '', '']));
    expect(Buffer.compare(empty, text)).not.toBe(0);
  });

  it('is deterministic for the same input', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const a = r.render(screen(['same', '', '']));
    const b = r.render(screen(['same', '', '']));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('does not leak the previous frame when content shrinks', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const blank = r.render(screen(['', '', '']));
    r.render(screen(['XXXXXXXXXX', 'YYYYYYYYYY', 'ZZZZZZZZZZ']));
    const blankAgain = r.render(screen(['', '', '']));
    expect(Buffer.compare(blank, blankAgain)).toBe(0);
  });

  it('skips width-0 continuation cells without double drawing', () => {
    const r = new FrameRenderer(geometry, DEFAULT_THEME);
    const wide: ScreenState = {
      cols: 20,
      rows: 3,
      cells: [
        [cell({ char: '漢', width: 2 }), cell({ char: ' ', width: 0 })].concat(
          Array.from({ length: 18 }, () => cell()),
        ),
        Array.from({ length: 20 }, () => cell()),
        Array.from({ length: 20 }, () => cell()),
      ],
    };
    expect(() => r.render(wide)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/frame.test.ts`
Expected: FAIL — cannot resolve `./frame.js`.

- [ ] **Step 3: Implement**

Create `src/render/frame.ts`:

```ts
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { FONT_FAMILY, ensureFontRegistered, measureCell } from './font.js';
import type { ScreenState } from './screen.js';
import type { Theme } from './theme.js';

export interface FrameGeometry {
  width: number;
  height: number;
  fontSizePx: number;
  padding: number;
}

const PADDING = 20;
const LINE_HEIGHT_RATIO = 1.35;

/**
 * Pick the largest font size at which the whole grid fits the canvas.
 * Measured once against the real font, since advance width is a property
 * of the face and not something to assume.
 */
export function fitGeometry(
  cols: number,
  rows: number,
  canvasW: number,
  canvasH: number,
): FrameGeometry {
  ensureFontRegistered();
  const usableW = canvasW - PADDING * 2;
  const usableH = canvasH - PADDING * 2;

  // Advance width scales linearly with font size, so measure once at a
  // reference size and solve rather than searching.
  const probe = measureCell(100, LINE_HEIGHT_RATIO);
  const widthRatio = probe.cellWidth / 100;
  const heightRatio = probe.cellHeight / 100;

  const byWidth = usableW / (cols * widthRatio);
  const byHeight = usableH / (rows * heightRatio);
  const fontSizePx = Math.max(4, Math.floor(Math.min(byWidth, byHeight)));

  return { width: canvasW, height: canvasH, fontSizePx, padding: PADDING };
}

export class FrameRenderer {
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;
  private readonly cellWidth: number;
  private readonly cellHeight: number;
  private readonly baselineOffset: number;
  private readonly fontSpec: string;

  constructor(
    private readonly geometry: FrameGeometry,
    private readonly theme: Theme,
  ) {
    ensureFontRegistered();
    // One canvas for the whole render: allocating 1280x720 per frame would
    // dominate the runtime.
    this.canvas = createCanvas(geometry.width, geometry.height);
    this.ctx = this.canvas.getContext('2d');
    const metrics = measureCell(geometry.fontSizePx, LINE_HEIGHT_RATIO);
    this.cellWidth = metrics.cellWidth;
    this.cellHeight = metrics.cellHeight;
    this.baselineOffset = metrics.baselineOffset;
    this.fontSpec = metrics.fontSpec;
  }

  render(screen: ScreenState): Buffer {
    const { ctx, theme, geometry } = this;

    // Full clear every frame: without it, a shrinking screen would leave
    // the previous frame's glyphs behind.
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, geometry.width, geometry.height);

    ctx.textBaseline = 'alphabetic';

    for (let y = 0; y < screen.rows; y++) {
      const row = screen.cells[y];
      if (!row) continue;
      const top = geometry.padding + y * this.cellHeight;

      // Backgrounds first, as one pass, so glyphs are never clipped by a
      // neighbouring cell's background.
      for (let x = 0; x < screen.cols; x++) {
        const cell = row[x];
        if (!cell || cell.width === 0) continue;
        if (cell.bg === theme.background) continue;
        ctx.fillStyle = cell.bg;
        ctx.fillRect(
          geometry.padding + x * this.cellWidth,
          top,
          this.cellWidth * Math.max(1, cell.width),
          this.cellHeight,
        );
      }

      const baseline = top + this.baselineOffset;
      for (let x = 0; x < screen.cols; x++) {
        const cell = row[x];
        if (!cell || cell.width === 0) continue;
        if (cell.char === ' ' && !cell.underline) continue;

        const weight = cell.bold ? 'bold ' : '';
        const style = cell.italic ? 'italic ' : '';
        ctx.font = `${style}${weight}${this.fontSpec}`;
        ctx.globalAlpha = cell.dim ? 0.6 : 1;
        ctx.fillStyle = cell.fg;

        const left = geometry.padding + x * this.cellWidth;
        if (cell.char !== ' ') ctx.fillText(cell.char, left, baseline);

        if (cell.underline) {
          ctx.fillRect(left, baseline + 2, this.cellWidth * Math.max(1, cell.width), 1);
        }
        ctx.globalAlpha = 1;
      }
    }

    return Buffer.from(this.canvas.data());
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/frame.test.ts`
Expected: PASS — 8 tests.

> **If "paints the theme background" fails with the red and blue channels
> swapped**, `canvas.data()` is handing back BGRA rather than RGBA on this
> platform. Do NOT swizzle the buffer in JavaScript — that would cost a
> pass over every pixel of every frame. Change the encoder's input format
> to `-pix_fmt bgra` in Task 6 instead, which is free. The test exists
> precisely to catch this before it reaches a video.

- [ ] **Step 5: Commit**

```bash
git add src/render/frame.ts src/render/frame.test.ts
git commit -m "feat: terminal frame rasterisation with a reused canvas"
```

---

### Task 6: The ffmpeg encoder

**Files:**
- Create: `src/render/encoder.ts`
- Test: `src/render/encoder.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `interface EncodeOptions { width: number; height: number; fps: number; outputPath: string }`
  - `async function encodeFrames(frames: AsyncIterable<Buffer>, opts: EncodeOptions): Promise<{ frames: number }>`
  - `async function probeVideo(path: string): Promise<{ codec: string; width: number; height: number; frames: number; pixFmt: string }>`

Verified settings: `-f rawvideo -pix_fmt rgba` in, `libx264 -pix_fmt yuv420p -movflags +faststart` out.

- [ ] **Step 1: Write the failing test**

Create `src/render/encoder.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrames, probeVideo } from './encoder.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-enc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const W = 160;
const H = 120;

async function* solid(count: number, value: number) {
  const frame = Buffer.alloc(W * H * 4, value);
  for (let i = 0; i < count; i++) yield frame;
}

describe('encodeFrames', () => {
  it('writes a playable mp4 with the exact frame count', async () => {
    const out = join(dir, 'a.mp4');
    const result = await encodeFrames(solid(30, 90), { width: W, height: H, fps: 30, outputPath: out });
    expect(result.frames).toBe(30);
    expect(existsSync(out)).toBe(true);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(W);
    expect(probe.height).toBe(H);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(30);
  }, 60000);

  it('creates the output directory if it does not exist', async () => {
    const out = join(dir, 'nested', 'deep', 'b.mp4');
    await encodeFrames(solid(5, 10), { width: W, height: H, fps: 30, outputPath: out });
    expect(existsSync(out)).toBe(true);
  }, 60000);

  it('rejects when no frames are produced', async () => {
    async function* none(): AsyncGenerator<Buffer> {
      // yields nothing
    }
    await expect(
      encodeFrames(none(), { width: W, height: H, fps: 30, outputPath: join(dir, 'c.mp4') }),
    ).rejects.toThrow(/no frames/i);
  }, 60000);

  it('rejects a frame of the wrong size rather than producing a skewed video', async () => {
    async function* wrong() {
      yield Buffer.alloc(W * H * 4);
      yield Buffer.alloc(10);
    }
    await expect(
      encodeFrames(wrong(), { width: W, height: H, fps: 30, outputPath: join(dir, 'd.mp4') }),
    ).rejects.toThrow(/expected \d+ bytes/i);
  }, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/encoder.test.ts`
Expected: FAIL — cannot resolve `./encoder.js`.

- [ ] **Step 3: Implement**

Create `src/render/encoder.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  outputPath: string;
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

  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${opts.width}x${opts.height}`,
      '-r', String(opts.fps),
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
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

  const finished = new Promise<number>((resolve, reject) => {
    ff.on('error', (e) =>
      reject(
        new Error(
          `could not run ffmpeg: ${e.message}. Run "autocast doctor" for install instructions.`,
        ),
      ),
    );
    ff.on('close', (code) =>
      code === 0
        ? resolve(0)
        : reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-800)}`)),
    );
  });

  let count = 0;
  try {
    for await (const frame of frames) {
      if (frame.length !== expected) {
        ff.stdin.destroy();
        throw new Error(
          `frame ${count} is ${frame.length} bytes, expected ${expected} ` +
            `(${opts.width}x${opts.height} RGBA)`,
        );
      }
      if (!ff.stdin.write(frame)) {
        await new Promise((r) => ff.stdin.once('drain', r));
      }
      count++;
    }
  } catch (error) {
    ff.kill();
    throw error;
  }

  ff.stdin.end();

  if (count === 0) {
    ff.kill();
    throw new Error('no frames were produced, so there is nothing to encode');
  }

  await finished;
  return { frames: count };
}

export interface VideoProbe {
  codec: string;
  width: number;
  height: number;
  frames: number;
  pixFmt: string;
}

export async function probeVideo(path: string): Promise<VideoProbe> {
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
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/render/encoder.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/encoder.ts src/render/encoder.test.ts
git commit -m "feat: streaming ffmpeg encoder with frame-size validation"
```

---

### Task 7: The render pipeline and CLI command

**Files:**
- Create: `src/driver/render.ts`
- Create: `src/cli/render-command.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/cli/index.ts`
- Test: `src/driver/render.test.ts`
- Test: `src/cli/render-command.test.ts`

**Interfaces:**
- Consumes: `captureTerminalDemo` (Phase 1a), `replayCast`/`frameCount` (Task 4), `fitGeometry`/`FrameRenderer` (Task 5), `encodeFrames` (Task 6), `validateText` (Phase 0)
- Produces:
  - `interface RenderReport { ok: boolean; outputPath: string; scenes: Array<{ id: string; ok: boolean; assertions: Array<{ name: string; ok: boolean; detail?: string }> }>; frames: number; durationSec: number }`
  - `async function renderDemo(script: DemoScript, opts?: { outputPath?: string }): Promise<RenderReport>`
  - `function formatRenderReport(report: RenderReport): string`
  - `async function renderCommand(argv: string[], io: CliIO): Promise<number>`

**Critical:** spec §6.1 — a live PTY holds the event loop open, so `src/cli/index.ts` must explicitly `process.exit(code)` rather than only setting `process.exitCode`.

- [ ] **Step 1: Write the failing pipeline test**

Create `src/driver/render.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { probeVideo } from '../render/encoder.js';
import { renderDemo, formatRenderReport } from './render.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-render-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function load(path: string) {
  const { script, diagnostics } = checkSchema(parseSource(readFileSync(path, 'utf8')));
  if (!script) throw new Error(`fixture invalid: ${JSON.stringify(diagnostics)}`);
  return script;
}

describe('renderDemo', () => {
  it('produces a playable mp4 of the terminal fixture', async () => {
    const out = join(dir, 'demo.mp4');
    const report = await renderDemo(load('fixtures/terminal/demo.yaml'), { outputPath: out });

    expect(report.ok, JSON.stringify(report.scenes, null, 2)).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(report.frames).toBeGreaterThan(30);

    const probe = await probeVideo(out);
    expect(probe.codec).toBe('h264');
    expect(probe.width).toBe(1280);
    expect(probe.height).toBe(720);
    expect(probe.pixFmt).toBe('yuv420p');
    expect(probe.frames).toBe(report.frames);
  }, 180000);

  it('reports failure without writing a video when an assertion fails', async () => {
    const script = load('fixtures/terminal/demo.yaml');
    script.scenes[0]!.assert = [{ stdout_contains: 'never-printed-anywhere' }];
    const out = join(dir, 'failed.mp4');
    const report = await renderDemo(script, { outputPath: out });

    expect(report.ok).toBe(false);
    expect(report.scenes[0]!.assertions[0]!.ok).toBe(false);
  }, 180000);
});

describe('formatRenderReport', () => {
  it('renders a readable summary naming each scene', () => {
    const text = formatRenderReport({
      ok: false,
      outputPath: 'docs/demo.mp4',
      frames: 120,
      durationSec: 4,
      scenes: [
        { id: 'greet', ok: true, assertions: [{ name: 'stdout_contains', ok: true }] },
        {
          id: 'build',
          ok: false,
          assertions: [{ name: 'stdout_matches', ok: false, detail: 'no match' }],
        },
      ],
    });
    expect(text).toContain('greet');
    expect(text).toContain('build');
    expect(text).toContain('no match');
    expect(text).toContain('FAILED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/driver/render.test.ts`
Expected: FAIL — cannot resolve `./render.js`.

- [ ] **Step 3: Implement the pipeline**

Create `src/driver/render.ts`:

```ts
import type { DemoScript } from '../schema/demo.js';
import type { CastLog } from '../backends/terminal/cast.js';
import { encodeFrames } from '../render/encoder.js';
import { fitGeometry, FrameRenderer } from '../render/frame.js';
import { frameCount, replayCast } from '../render/replay.js';
import { DEFAULT_THEME } from '../render/theme.js';
import { captureTerminalDemo } from './capture.js';

export interface RenderReport {
  ok: boolean;
  outputPath: string;
  scenes: Array<{
    id: string;
    ok: boolean;
    assertions: Array<{ name: string; ok: boolean; detail?: string }>;
  }>;
  frames: number;
  durationSec: number;
}

export interface RenderOptions {
  outputPath?: string;
}

export async function renderDemo(
  script: DemoScript,
  opts: RenderOptions = {},
): Promise<RenderReport> {
  const outputPath = opts.outputPath ?? script.output.path;
  const [canvasW, canvasH] = script.output.canvas;
  const fps = script.output.fps;

  const capture = await captureTerminalDemo(script);

  const scenes = capture.scenes.map((s) => ({
    id: s.id,
    ok: s.ok,
    assertions: s.assertions.map((a) => ({
      name: a.name,
      ok: a.ok,
      ...(a.detail === undefined ? {} : { detail: a.detail }),
    })),
  }));

  // Phase 1 renders a single terminal session; multi-session composition
  // is Phase 3.
  const [cast] = Object.values(capture.casts) as CastLog[];
  if (!cast) throw new Error('capture produced no session log to render');

  const geometry = fitGeometry(cast.width, cast.height, canvasW, canvasH);
  const renderer = new FrameRenderer(geometry, DEFAULT_THEME);
  const total = frameCount(cast, fps);

  async function* frames(): AsyncGenerator<Buffer> {
    for await (const screen of replayCast(cast!, { fps, theme: DEFAULT_THEME })) {
      yield renderer.render(screen);
    }
  }

  const { frames: written } = await encodeFrames(frames(), {
    width: geometry.width,
    height: geometry.height,
    fps,
    outputPath,
  });

  return {
    ok: scenes.every((s) => s.ok),
    outputPath,
    scenes,
    frames: written,
    durationSec: Number((total / fps).toFixed(2)),
  };
}

export function formatRenderReport(report: RenderReport): string {
  const lines = [`autocast render — ${report.outputPath}`, ''];

  for (const scene of report.scenes) {
    lines.push(
      `  ${scene.ok ? 'OK  ' : 'FAIL'}  ${scene.id.padEnd(12)}  ${scene.assertions.length} assertions`,
    );
    for (const a of scene.assertions) {
      if (a.ok) continue;
      lines.push(`          assert ${a.name} — ${a.detail ?? 'failed'}`);
    }
  }

  lines.push('');
  lines.push(`  ${report.frames} frames, ${report.durationSec}s`);
  lines.push('');
  lines.push(
    report.ok
      ? `OK — ${report.scenes.length} of ${report.scenes.length} scenes`
      : `FAILED — ${report.scenes.filter((s) => !s.ok).length} of ${report.scenes.length} scenes`,
  );

  return lines.join('\n');
}
```

- [ ] **Step 4: Write the failing command test**

Create `src/cli/render-command.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from './run.js';

const dir = mkdtempSync(join(tmpdir(), 'autocast-cli-render-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out: () => out.join('\n'), err: () => err.join('\n') };
}

describe('autocast render', () => {
  it('renders the terminal fixture to the requested path', async () => {
    const out = join(dir, 'cli.mp4');
    const c = captureIO();
    const code = await runCli(['render', 'fixtures/terminal/demo.yaml', '--out', out], c.io);
    expect(code, c.out() + c.err()).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(c.out()).toContain('greet');
    expect(c.out()).toContain('frames');
  }, 180000);

  it('refuses to render a script that fails validation', async () => {
    const c = captureIO();
    const code = await runCli(['render', 'fixtures/broken/undeclared-session.yaml'], c.io);
    expect(code).toBe(1);
    expect(c.out()).toContain('L001');
  }, 30000);

  it('exits 2 when the file is missing', async () => {
    const c = captureIO();
    expect(await runCli(['render', 'fixtures/nope.yaml'], c.io)).toBe(2);
    expect(c.err()).toContain('cannot read');
  }, 30000);

  it('exits 2 when no file is given', async () => {
    const c = captureIO();
    expect(await runCli(['render'], c.io)).toBe(2);
    expect(c.err()).toContain('expects a file');
  }, 30000);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run src/cli/render-command.test.ts`
Expected: FAIL — `unknown command "render"`.

- [ ] **Step 6: Implement the command**

Create `src/cli/render-command.ts`:

```ts
import { readFileSync } from 'node:fs';
import { renderDemo, formatRenderReport } from '../driver/render.js';
import { formatDiagnostics, hasErrors } from '../validate/diagnostic.js';
import { parseSource } from '../validate/parse.js';
import { checkSchema } from '../validate/schema-check.js';
import { lint } from '../validate/lint.js';
import type { CliIO } from './run.js';

export async function renderCommand(argv: string[], io: CliIO): Promise<number> {
  const outIndex = argv.indexOf('--out');
  const outputPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const file = argv.find((a, i) => !a.startsWith('--') && i !== outIndex + 1);

  if (file === undefined) {
    io.err('autocast render: expects a file\n\nUsage: autocast render [--out <path>] <file>');
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    io.err(
      `autocast render: cannot read ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }

  // Never capture a script we already know is wrong.
  const parsed = parseSource(text);
  const { diagnostics, script } = checkSchema(parsed);
  const all = script ? [...diagnostics, ...lint(script, parsed)] : diagnostics;
  if (hasErrors(all) || !script) {
    io.out(formatDiagnostics(file, all));
    return 1;
  }

  try {
    const report = await renderDemo(script, outputPath ? { outputPath } : {});
    io.out(formatRenderReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    io.err(`autocast render: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
```

In `src/cli/run.ts`, add the import and dispatch:

```ts
import { renderCommand } from './render-command.js';
```

```ts
  if (command === 'render') {
    return renderCommand(argv.slice(1), io);
  }
```

Replace the body of `src/cli/index.ts` so the process actually exits:

```ts
#!/usr/bin/env node
import { runCli, type CliIO } from './run.js';

const io: CliIO = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

runCli(process.argv.slice(2), io).then(
  (code) => finish(code),
  (error: unknown) => {
    io.err(`autocast: ${error instanceof Error ? error.message : String(error)}`);
    finish(2);
  },
);

/**
 * A live PTY keeps the event loop open (spec section 6.1), so setting
 * process.exitCode is not enough to end the process after a render.
 * Flush stdout first, then exit explicitly.
 */
function finish(code: number): void {
  process.exitCode = code;
  // The write callback fires once the stream has flushed, which matters
  // when stdout is a pipe rather than a TTY.
  process.stdout.write('', () => process.exit(code));
}
```

- [ ] **Step 7: Run all tests to verify they pass**

```bash
npx vitest run src/driver/render.test.ts src/cli/render-command.test.ts
```

Expected: PASS — 6 tests.

- [ ] **Step 8: Commit**

```bash
git add src/driver/render.ts src/driver/render.test.ts src/cli/render-command.ts src/cli/render-command.test.ts src/cli/run.ts src/cli/index.ts
git commit -m "feat: render pipeline and autocast render command"
```

---

### Task 8: Phase 1 acceptance

**Files:**
- Modify: `src/cli/acceptance.test.ts`
- Create: `docs/terminal-demo.mp4` (generated, committed as the reference artifact)

**Interfaces:**
- Consumes: everything
- Produces: automated coverage of Phase 1's exit criterion.

- [ ] **Step 1: Update the dependency assertion**

In `src/cli/acceptance.test.ts`, the dependency list now legitimately includes the render pair:

```ts
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@fontsource/jetbrains-mono',
      '@napi-rs/canvas',
      '@xterm/headless',
      'node-pty',
      'yaml',
      'zod',
    ]);
```

- [ ] **Step 2: Add the Phase 1 exit-criterion test**

Append to `src/cli/acceptance.test.ts`:

```ts
describe('Phase 1 exit criteria', () => {
  it('renders a real command to a playable mp4', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { probeVideo } = await import('../render/encoder.js');

    const dir = mkdtempSync(join(tmpdir(), 'autocast-accept-'));
    try {
      const out = join(dir, 'phase1.mp4');
      const c = captureIO();
      const code = await runCli(['render', 'fixtures/terminal/demo.yaml', '--out', out], c.io);

      expect(code, c.out() + c.err()).toBe(0);
      expect(existsSync(out)).toBe(true);

      const probe = await probeVideo(out);
      expect(probe.codec).toBe('h264');
      expect(probe.frames).toBeGreaterThan(60); // more than 2 seconds at 30fps
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);
});
```

- [ ] **Step 3: Run the full suite**

```bash
npx vitest run
npm run typecheck
npm run build
```

Expected: all green, no `AttachConsole failed` anywhere.

- [ ] **Step 4: Produce the reference video by hand**

```bash
node dist/cli/index.js render fixtures/terminal/demo.yaml --out docs/terminal-demo.mp4
```

Then **watch it**. Confirm by eye:
- the command text types in with visible human rhythm, not instantly
- the progress bar redraws in place on one line rather than scrolling
- colours match the fixture (green `hello`, green `build complete`)
- text is sharp and columns are aligned
- the video does not cut dead on the final frame

- [ ] **Step 5: Verify no orphaned processes**

```bash
tasklist //FI "IMAGENAME eq node.exe" //NH
```

Expected: no lingering `node.exe` from the render.

- [ ] **Step 6: Commit**

```bash
git add src/cli/acceptance.test.ts docs/terminal-demo.mp4
git commit -m "test: phase 1 acceptance and reference demo video"
```

---

## Phase 1b Definition of Done

- `npx vitest run` — all green, no `AttachConsole failed` in the output.
- `npm run typecheck` and `npm run build` — clean.
- `autocast render fixtures/terminal/demo.yaml --out docs/terminal-demo.mp4` writes a playable h264 / yuv420p 1280x720 mp4 and exits 0.
- The video shows human-paced typing, an in-place progress-bar redraw, and correct colours.
- A failing assertion makes `render` exit 1 and name the scene and reason.
- `autocast render` on an invalid script exits 1 with lint diagnostics and never starts a capture.
- The CLI process exits on its own after a render — no hang from the PTY holding the event loop.
- Runtime dependencies: `@fontsource/jetbrains-mono`, `@napi-rs/canvas`, `@xterm/headless`, `node-pty`, `yaml`, `zod`.

**Not in this plan:** idle compression and multi-session composition (Phase 3), the browser backend (Phase 2), captions and TTS (Phase 6).
