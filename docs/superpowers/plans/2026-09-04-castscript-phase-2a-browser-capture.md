# castscript Phase 2a — Browser capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a real browser from a validated demo script and capture it as timestamped frames on disk, with assertions — no rendering, no video.

**Architecture:** A `BrowserSession` wraps a Playwright page and a CDP session. `Page.screencastFrame` events are written to disk as JPEG files with a timestamp manifest; nothing is held in memory. Because the screencast is change-driven, the manifest — not the frame count — is the authoritative record of time. Steps and assertions mirror the terminal backend's shapes so the driver can treat both uniformly.

**Tech Stack:** `playwright` 1.62.1 (Chromium). Existing: TypeScript 5.9, Node 20+, vitest 3.

**Spec:** `docs/superpowers/specs/2026-09-04-castscript-design.md` — especially §4.1, §4.5, §4.5.1, §4.6 and §8.

## Global Constraints

- **Node 20+**, ESM. Windows, macOS and Linux all first-class.
- **New runtime dependency: `playwright` only.**
- **Frame size follows the CSS viewport.** `deviceScaleFactor` is ignored by the screencast (§4.5.1) — never set it expecting more pixels. Set the viewport to the output canvas size.
- **Frame timestamps are unix SECONDS as a float** (`1788551698.609511`), not milliseconds. Multiplying by 1000 at the wrong place is a 1000x timing bug.
- **The screencast is change-driven.** A still page emits roughly one frame every three seconds. Never assume a frame per tick, never derive duration from frame count, and never wait for a frame that may not come.
- **Every frame must be acknowledged** with `Page.screencastFrameAck`, or Chromium stops sending after a few frames.
- **Frames go straight to disk**, never accumulated in memory (spec §13).
- **Browser-only steps and assertions must throw if they reach the terminal backend and vice versa** — lint rules L008/L009 catch these earlier, so arriving here is a bug.
- **TDD is mandatory.** Failing test first, watch it fail, then implement.
- Every fixture must work offline. No network, no CDN, no external fonts.

---

### Task 1: The web fixture app

**Files:**
- Create: `fixtures/web-app/server.mjs`
- Create: `fixtures/web-app/public/index.html`
- Create: `fixtures/web-app/README.md`
- Test: `fixtures/web-app/server.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a dependency-free Node HTTP server exposing a static page plus a JSON API, started with `node fixtures/web-app/server.mjs [port]`, printing `listening on :<port>` when ready. It must never require an npm install.

The page deliberately includes a deliberately slow endpoint, so `wait_for` has something real to wait on, and a small target element so `focus:` zoom has something worth zooming into.

- [ ] **Step 1: Write the failing test**

Create `fixtures/web-app/server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 34567;
let proc: ChildProcess;

beforeAll(async () => {
  proc = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    proc.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

afterAll(() => {
  proc.kill();
});

describe('web-app fixture', () => {
  it('serves the page', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-test="new-order"');
  });

  it('accepts an order and echoes the quantity', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty: 3 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ qty: 3, status: 'confirmed' });
  });

  it('has a deliberately slow endpoint for wait_for to wait on', async () => {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${PORT}/api/slow`);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it('404s an unknown path', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run fixtures/web-app/server.test.ts`
Expected: FAIL — the server file does not exist.

- [ ] **Step 3: Write the fixture**

Create `fixtures/web-app/server.mjs`:

```js
#!/usr/bin/env node
// A dependency-free HTTP server used by castscript's browser tests.
// Never add npm dependencies: tests must run with no install and no network.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 3000);
const orders = [];

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(join(here, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/slow') {
    // Something for wait_for to genuinely wait on.
    setTimeout(() => json(res, 200, { ready: true }), 500);
    return;
  }

  if (url.pathname === '/api/orders' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let qty = 1;
    try {
      qty = Number(JSON.parse(body || '{}').qty ?? 1);
    } catch {
      return json(res, 400, { error: 'bad json' });
    }
    const order = { id: orders.length + 1, qty, status: 'confirmed' };
    orders.push(order);
    process.stdout.write(`POST /api/orders 201 qty=${qty}\n`);
    return json(res, 201, order);
  }

  if (url.pathname === '/api/orders') return json(res, 200, orders);

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening on :${port}\n`);
});
```

Create `fixtures/web-app/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>castscript order desk</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        background: #f6f7fb;
        color: #16161d;
      }
      header { padding: 20px 28px; background: #1c1c22; color: #fff; }
      h1 { margin: 0; font-size: 18px; letter-spacing: 0.01em; }
      main { padding: 28px; max-width: 640px; }
      .card {
        background: #fff; border: 1px solid #e2e3ec; border-radius: 10px;
        padding: 20px; box-shadow: 0 1px 2px rgba(20, 20, 40, 0.05);
      }
      label { display: block; font-size: 12px; color: #5b5b6b; margin-bottom: 4px; }
      input {
        width: 96px; padding: 7px 9px; font: inherit;
        border: 1px solid #ccccd8; border-radius: 6px;
      }
      button {
        margin-top: 14px; padding: 8px 16px; font: inherit; font-weight: 600;
        color: #fff; background: #3b5bdb; border: 0; border-radius: 6px; cursor: pointer;
      }
      button.secondary { background: #52525e; }
      .order-confirmed {
        margin-top: 18px; padding: 12px 14px; border-radius: 8px;
        background: #e7f8ec; border: 1px solid #a8dfba; color: #16632f;
        font-size: 13px;
      }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <header><h1>castscript order desk</h1></header>
    <main>
      <div class="card">
        <button data-test="new-order" class="secondary">New order</button>
        <div data-test="order-form" hidden style="margin-top: 16px">
          <label for="qty">Quantity</label>
          <input id="qty" value="1" />
          <br />
          <button id="submit">Submit</button>
        </div>
        <div class="order-confirmed" hidden>
          Order confirmed — <span id="confirmed-qty"></span> unit(s).
        </div>
      </div>
    </main>
    <script>
      const $ = (s) => document.querySelector(s);
      $('[data-test=new-order]').addEventListener('click', () => {
        $('[data-test=order-form]').hidden = false;
      });
      $('#submit').addEventListener('click', async () => {
        await fetch('/api/slow');
        const qty = Number($('#qty').value || 1);
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ qty }),
        });
        const order = await res.json();
        $('#confirmed-qty').textContent = String(order.qty);
        $('.order-confirmed').hidden = false;
      });
    </script>
  </body>
</html>
```

Create `fixtures/web-app/README.md`:

```markdown
# web-app fixture

A dependency-free HTTP server used by castscript's browser tests. Never add
npm dependencies — tests must run with no install and no network.

    node fixtures/web-app/server.mjs 3000

| Route | Purpose |
|---|---|
| `GET /` | The order-desk page |
| `GET /api/slow` | Sleeps 500ms, so `wait_for` has something real to wait on |
| `POST /api/orders` | Creates an order, logs `POST /api/orders 201` to stdout |
| `GET /api/orders` | Lists orders |

The page keeps `[data-test=order-form]` small on purpose, so `focus:` zoom
has a worthwhile target.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run fixtures/web-app/server.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add fixtures/web-app/
git commit -m "test: dependency-free web fixture for browser capture"
```

---

### Task 2: Doctor learns about Chromium

**Files:**
- Modify: `src/doctor/checks.ts`
- Modify: `src/doctor/checks.test.ts`

**Interfaces:**
- Consumes: `Check`, `CheckResult`, `CHECKS`
- Produces: a `chromium` entry appended to `CHECKS`, verifying the browser binary is actually on disk rather than merely that Playwright is installed.

- [ ] **Step 1: Write the failing test**

Append to `src/doctor/checks.test.ts`:

```ts
describe('chromium check', () => {
  it('is registered in the default check list', () => {
    expect(CHECKS.map((c) => c.name)).toContain('chromium');
  });

  it('reports ok when the browser binary exists', async () => {
    const check = CHECKS.find((c) => c.name === 'chromium')!;
    const r = await check.run();
    expect(r.status).toBe('ok');
  });

  it('names the install command when it is missing', async () => {
    const check = CHECKS.find((c) => c.name === 'chromium')!;
    const r = await check.run();
    if (r.status !== 'ok') {
      expect(r.hint).toContain('playwright install chromium');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/doctor/checks.test.ts`
Expected: FAIL — `chromium` is not in `CHECKS`.

- [ ] **Step 3: Implement**

Add to `src/doctor/checks.ts`, before the `CHECKS` export:

```ts
const chromiumCheck: Check = {
  name: 'chromium',
  async run() {
    try {
      const { chromium } = (await import('playwright')) as {
        chromium: { executablePath(): string };
      };
      const path = chromium.executablePath();
      await access(path, constants.X_OK);
      return { name: 'chromium', status: 'ok', detail: path };
    } catch (error) {
      return {
        name: 'chromium',
        status: 'fail',
        detail:
          error instanceof Error && 'code' in error
            ? 'browser binary not found'
            : `playwright unavailable: ${error instanceof Error ? error.message : String(error)}`,
        hint: [
          '    castscript drives a real Chromium for browser scenes.',
          '    Install it with:',
          '      npx playwright install chromium',
        ].join('\n'),
      };
    }
  },
};
```

Register it:

```ts
export const CHECKS: Check[] = [
  ffmpegCheck,
  x264Check,
  rubberbandCheck,
  nodePtyCheck,
  chromiumCheck,
  cwdWritableCheck,
];
```

- [ ] **Step 4: Run tests and verify by hand**

```bash
npx vitest run src/doctor/
npm run build && node dist/cli/index.js doctor
```

Expected: a `chromium` row naming the executable path.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/checks.ts src/doctor/checks.test.ts
git commit -m "feat: doctor verifies the chromium binary is installed"
```

---

### Task 3: The frame store

**Files:**
- Create: `src/backends/browser/frame-store.ts`
- Test: `src/backends/browser/frame-store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface StoredFrame { path: string; tSec: number }`
  - `interface FrameManifest { dir: string; width: number; height: number; frames: StoredFrame[] }`
  - `class FrameStore` with `constructor(dir: string)`, `async add(base64Jpeg: string, tSec: number): Promise<void>`, `manifest(width: number, height: number): FrameManifest`, `async writeManifest(): Promise<string>`, `async dispose(): Promise<void>`
  - `function relativeTimeline(manifest: FrameManifest): StoredFrame[]` — rebases absolute unix seconds onto zero

Frames are written to disk as they arrive. The timestamps, not the frame count, are the record of time (§4.5.1).

- [ ] **Step 1: Write the failing test**

Create `src/backends/browser/frame-store.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameStore, relativeTimeline } from './frame-store.js';

const dirs: string[] = [];
const newDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'castscript-frames-'));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/browser/frame-store.test.ts`
Expected: FAIL — cannot resolve `./frame-store.js`.

- [ ] **Step 3: Implement**

Create `src/backends/browser/frame-store.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/browser/frame-store.test.ts`
Expected: PASS — 7 tests.

> `writeManifest()` is declared with two optional parameters but the test
> calls it with none. That is intentional: the manifest on disk is a
> debugging aid, and geometry is supplied by the caller that knows it.

- [ ] **Step 5: Commit**

```bash
git add src/backends/browser/frame-store.ts src/backends/browser/frame-store.test.ts
git commit -m "feat: on-disk frame store with authoritative timestamps"
```

---

### Task 4: The browser session

**Files:**
- Modify: `package.json` (add `playwright`)
- Create: `src/backends/browser/session.ts`
- Test: `src/backends/browser/session.test.ts`

**Interfaces:**
- Consumes: `FrameStore`, `FrameManifest` (Task 3)
- Produces:
  - `interface BrowserSessionOptions { viewport?: [number, number]; framesDir: string; attachCdp?: string }`
  - `interface BrowserSession` with:
    - `readonly page: Page` (Playwright's type)
    - `goto(url: string): Promise<void>`
    - `startCapture(): Promise<void>` / `stopCapture(): Promise<void>`
    - `setZoom(scale: number): Promise<void>` — CDP `Emulation.setPageScaleFactor`
    - `boundingBox(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null>`
    - `consoleErrors(): string[]` / `failedRequests(): string[]`
    - `manifest(): FrameManifest`
    - `dispose(): Promise<void>` — idempotent
  - `async function openBrowserSession(opts: BrowserSessionOptions): Promise<BrowserSession>`

- [ ] **Step 1: Install the dependency**

```bash
npm install playwright@^1.62.1
npx playwright install chromium
```

- [ ] **Step 2: Write the failing test**

Create `src/backends/browser/session.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';

const PORT = 34568;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}, 30000);

afterAll(() => server.kill());

const open: BrowserSession[] = [];
const dirs: string[] = [];

async function session(viewport: [number, number] = [640, 400]) {
  const dir = mkdtempSync(join(tmpdir(), 'castscript-bs-'));
  dirs.push(dir);
  const s = await openBrowserSession({ viewport, framesDir: join(dir, 'frames') });
  open.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('BrowserSession', () => {
  it('loads a page and reads its content', async () => {
    const s = await session();
    await s.goto(BASE);
    expect(await s.page.title()).toContain('castscript');
  }, 60000);

  it('captures frames at the CSS viewport size, not deviceScaleFactor', async () => {
    const s = await session([640, 400]);
    await s.goto(BASE);
    await s.startCapture();
    await s.page.click('[data-test=new-order]');
    await s.page.waitForTimeout(400);
    await s.stopCapture();

    const m = s.manifest();
    expect(m.frames.length).toBeGreaterThan(0);

    // Decode a real frame. Asserting on m.width alone would only echo the
    // viewport we passed in — it would pass even if the frames were the
    // wrong size, which is exactly the claim spec 4.5.1 rests on.
    const { loadImage } = await import('@napi-rs/canvas');
    const { readFileSync } = await import('node:fs');
    const img = await loadImage(readFileSync(m.frames[0]!.path));
    expect(img.width).toBe(640);
    expect(img.height).toBe(400);
  }, 60000);

  it('records timestamps in unix seconds, increasing', async () => {
    const s = await session();
    await s.goto(BASE);
    await s.startCapture();
    for (let i = 0; i < 3; i++) {
      await s.page.click('[data-test=new-order]');
      await s.page.waitForTimeout(150);
    }
    await s.stopCapture();

    const ts = s.manifest().frames.map((f) => f.tSec);
    expect(ts.length).toBeGreaterThan(0);
    expect(ts[0]).toBeGreaterThan(1_000_000_000); // unix SECONDS, not ms
    expect(ts[0]).toBeLessThan(100_000_000_000);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]!);
  }, 60000);

  it('keeps acknowledging frames so capture does not stall', async () => {
    const s = await session();
    await s.goto(BASE);
    await s.startCapture();
    // Force many repaints; without frame acks Chromium stops after a few.
    for (let i = 0; i < 12; i++) {
      await s.page.evaluate((n: number) => {
        document.title = `t${n}`;
        document.body.style.background = n % 2 ? '#eee' : '#fff';
      }, i);
      await s.page.waitForTimeout(60);
    }
    await s.stopCapture();
    expect(s.manifest().frames.length).toBeGreaterThan(5);
  }, 60000);

  it('returns an element bounding box in CSS pixels', async () => {
    const s = await session();
    await s.goto(BASE);
    const box = await s.boundingBox('[data-test=new-order]');
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  }, 60000);

  it('returns null for a selector that does not exist', async () => {
    const s = await session();
    await s.goto(BASE);
    expect(await s.boundingBox('#nothing-here')).toBeNull();
  }, 60000);

  it('applies zoom without changing the frame size', async () => {
    const s = await session([640, 400]);
    await s.goto(BASE);
    await s.setZoom(2);
    await s.startCapture();
    await s.page.click('[data-test=new-order]');
    await s.page.waitForTimeout(300);
    await s.stopCapture();
    expect(s.manifest().width).toBe(640);
  }, 60000);

  it('collects console errors and failed requests', async () => {
    const s = await session();
    await s.goto(BASE);
    await s.page.evaluate(() => console.error('deliberate-console-error'));
    await s.page.waitForTimeout(200);
    expect(s.consoleErrors().join(' ')).toContain('deliberate-console-error');
    expect(Array.isArray(s.failedRequests())).toBe(true);
  }, 60000);

  it('dispose is idempotent', async () => {
    const s = await session();
    await s.dispose();
    await expect(s.dispose()).resolves.toBeUndefined();
  }, 60000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/backends/browser/session.test.ts`
Expected: FAIL — cannot resolve `./session.js`.

- [ ] **Step 4: Implement**

Create `src/backends/browser/session.ts`:

```ts
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { FrameStore, type FrameManifest } from './frame-store.js';

export interface BrowserSessionOptions {
  viewport?: [number, number];
  framesDir: string;
  /** Attach to an existing CDP endpoint — Electron and Tauri apps. */
  attachCdp?: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSession {
  readonly page: Page;
  goto(url: string): Promise<void>;
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  setZoom(scale: number): Promise<void>;
  boundingBox(selector: string): Promise<BoundingBox | null>;
  consoleErrors(): string[];
  failedRequests(): string[];
  manifest(): FrameManifest;
  dispose(): Promise<void>;
}

export async function openBrowserSession(
  opts: BrowserSessionOptions,
): Promise<BrowserSession> {
  const { chromium } = await import('playwright');
  const [width, height] = opts.viewport ?? [1280, 720];

  let browser: Browser;
  let context: BrowserContext;

  if (opts.attachCdp) {
    // Electron/Tauri: drive an app that is already running.
    browser = await chromium.connectOverCDP(opts.attachCdp);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    browser = await chromium.launch({ headless: true });
    // deviceScaleFactor is deliberately absent: the screencast ignores it
    // (spec section 4.5.1), so it would only mislead.
    context = await browser.newContext({ viewport: { width, height } });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  if (opts.attachCdp) await page.setViewportSize({ width, height });

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('requestfailed', (r) => failedRequests.push(r.url()));

  const store = new FrameStore(opts.framesDir);
  const client: CDPSession = await context.newCDPSession(page);
  let capturing = false;
  let disposed = false;
  /** Serialises disk writes so frames land in arrival order. */
  let writes: Promise<void> = Promise.resolve();

  client.on('Page.screencastFrame', (frame) => {
    // Acknowledge FIRST and unconditionally: Chromium stops sending after
    // a few unacknowledged frames, which would silently truncate capture.
    void client
      .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
      .catch(() => undefined);
    // Falling back to 0 would put a frame at the unix epoch and wreck the
    // whole timeline; wall clock is at least in the right era.
    const tSec = frame.metadata.timestamp ?? Date.now() / 1000;
    writes = writes.then(() => store.add(frame.data, tSec).catch(() => undefined));
  });

  const session: BrowserSession = {
    page,

    async goto(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },

    async startCapture() {
      if (capturing) return;
      capturing = true;
      await client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 85,
        everyNthFrame: 1,
      });
    },

    async stopCapture() {
      if (!capturing) return;
      capturing = false;
      await client.send('Page.stopScreencast').catch(() => undefined);
      await writes; // let queued frames finish landing on disk
    },

    async setZoom(scale) {
      // In-browser zoom: Chromium re-rasterises at this scale, so zoomed
      // text is natively sharp rather than an upscaled crop (spec 4.5).
      await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: scale });
    },

    async boundingBox(selector) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) return null;
      return locator.boundingBox();
    },

    consoleErrors: () => [...consoleErrors],
    failedRequests: () => [...failedRequests],
    manifest: () => store.manifest(width, height),

    async dispose() {
      if (disposed) return;
      disposed = true;
      capturing = false;
      await client.send('Page.stopScreencast').catch(() => undefined);
      await writes;
      await browser.close().catch(() => undefined);
    },
  };

  return session;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/backends/browser/session.test.ts`
Expected: PASS — 9 tests.

> If "keeps acknowledging frames" fails with very few frames, the ack is
> not reaching Chromium. Do NOT lower the assertion — the ack is what
> keeps the screencast alive, and a truncated capture is a silent
> data-loss bug.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/backends/browser/session.ts src/backends/browser/session.test.ts
git commit -m "feat: browser session over Playwright CDP screencast"
```

---

### Task 5: Browser step execution

**Files:**
- Create: `src/backends/browser/steps.ts`
- Test: `src/backends/browser/steps.test.ts`

**Interfaces:**
- Consumes: `BrowserSession` (Task 4), `StepResult` (reused from `src/backends/terminal/steps.js`)
- Produces:
  - `interface BrowserStepContext { session: BrowserSession; settleMs: number; now: () => number; baseUrl?: string }`
  - `async function executeBrowserStep(step: Record<string, unknown>, ctx: BrowserStepContext): Promise<StepResult>`

Supported: `goto`, `click`, `fill`, `wait_for` (selector), `sleep`, `type` (into the focused element). Terminal-only keys throw.

- [ ] **Step 1: Write the failing test**

Create `src/backends/browser/steps.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';
import { executeBrowserStep, type BrowserStepContext } from './steps.js';

const PORT = 34569;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}, 30000);

afterAll(() => server.kill());

const open: BrowserSession[] = [];
const dirs: string[] = [];

async function ctx(): Promise<BrowserStepContext> {
  const dir = mkdtempSync(join(tmpdir(), 'castscript-bsteps-'));
  dirs.push(dir);
  const session = await openBrowserSession({
    viewport: [640, 400],
    framesDir: join(dir, 'frames'),
  });
  open.push(session);
  return { session, settleMs: 50, now: () => Date.now() };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('executeBrowserStep', () => {
  it('goto loads the page', async () => {
    const c = await ctx();
    const r = await executeBrowserStep({ goto: BASE }, c);
    expect(r.ok).toBe(true);
    expect(c.session.page.url()).toContain(String(PORT));
  }, 60000);

  it('click activates an element', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    const r = await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    expect(r.ok).toBe(true);
    expect(await c.session.page.locator('[data-test=order-form]').isVisible()).toBe(true);
  }, 60000);

  it('fill sets an input value', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    const r = await executeBrowserStep({ fill: { selector: '#qty', value: '7' } }, c);
    expect(r.ok).toBe(true);
    expect(await c.session.page.locator('#qty').inputValue()).toBe('7');
  }, 60000);

  it('wait_for resolves when a selector appears', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    await executeBrowserStep({ click: '[data-test=new-order]' }, c);
    await executeBrowserStep({ fill: { selector: '#qty', value: '2' } }, c);
    await executeBrowserStep({ click: '#submit' }, c);
    const r = await executeBrowserStep({ wait_for: { selector: '.order-confirmed' } }, c);
    expect(r.ok).toBe(true);
  }, 60000);

  it('click fails with a useful detail when the selector is missing', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    const r = await executeBrowserStep({ click: '#does-not-exist' }, { ...c, settleMs: 10 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('#does-not-exist');
  }, 60000);

  it('wait_for fails with a timeout detail', async () => {
    const c = await ctx();
    await executeBrowserStep({ goto: BASE }, c);
    const r = await executeBrowserStep(
      { wait_for: { selector: '.never-appears', timeout: 800 } },
      c,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('.never-appears');
  }, 60000);

  it('throws on a terminal-only step, which lint should have caught', async () => {
    const c = await ctx();
    await expect(executeBrowserStep({ run: 'ls' }, c)).rejects.toThrow(/terminal/i);
  }, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/browser/steps.test.ts`
Expected: FAIL — cannot resolve `./steps.js`.

- [ ] **Step 3: Implement**

Create `src/backends/browser/steps.ts`:

```ts
import type { StepResult } from '../terminal/steps.js';
import type { BrowserSession } from './session.js';

export interface BrowserStepContext {
  session: BrowserSession;
  settleMs: number;
  now: () => number;
}

const DEFAULT_WAIT_MS = 30000;

function toMs(d: number | string | undefined, fallback: number): number {
  if (d === undefined) return fallback;
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(d);
  if (!m) return fallback;
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const message = (e: unknown): string =>
  e instanceof Error ? e.message.split('\n')[0]! : String(e);

export async function executeBrowserStep(
  step: Record<string, unknown>,
  ctx: BrowserStepContext,
): Promise<StepResult> {
  const startedAt = ctx.now();
  const done = (ok: boolean, detail?: string): StepResult => ({
    ok,
    startedAt,
    endedAt: ctx.now(),
    ...(detail === undefined ? {} : { detail }),
  });
  const { page } = ctx.session;

  if (typeof step.goto === 'string') {
    try {
      await ctx.session.goto(step.goto);
      await sleep(ctx.settleMs);
      return done(true);
    } catch (e) {
      return done(false, `could not load ${step.goto}: ${message(e)}`);
    }
  }

  if (typeof step.click === 'string') {
    const selector = step.click;
    try {
      await page.locator(selector).first().click({ timeout: DEFAULT_WAIT_MS });
      await sleep(ctx.settleMs);
      return done(true);
    } catch (e) {
      return done(false, `could not click ${selector}: ${message(e)}`);
    }
  }

  if (step.fill !== undefined) {
    const f = step.fill as { selector: string; value: string };
    try {
      await page.locator(f.selector).first().fill(f.value, { timeout: DEFAULT_WAIT_MS });
      await sleep(ctx.settleMs);
      return done(true);
    } catch (e) {
      return done(false, `could not fill ${f.selector}: ${message(e)}`);
    }
  }

  if (typeof step.type === 'string') {
    await page.keyboard.type(step.type);
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (typeof step.key === 'string') {
    await page.keyboard.press(step.key);
    await sleep(ctx.settleMs);
    return done(true);
  }

  if (step.wait_for !== undefined) {
    const w = step.wait_for as { selector?: string; stdout?: string; timeout?: number | string };
    if (w.stdout !== undefined) {
      throw new Error(
        'wait_for.stdout is terminal-only; lint rule L008 should have caught this',
      );
    }
    if (w.selector === undefined) {
      return done(false, 'wait_for on a browser session needs a selector');
    }
    const timeout = toMs(w.timeout, DEFAULT_WAIT_MS);
    try {
      await page.locator(w.selector).first().waitFor({ state: 'visible', timeout });
      return done(true);
    } catch {
      return done(false, `timed out after ${timeout}ms waiting for ${w.selector} to be visible`);
    }
  }

  if (step.sleep !== undefined) {
    await sleep(toMs(step.sleep as number | string, 0));
    return done(true);
  }

  const key = Object.keys(step)[0] ?? '(empty)';
  throw new Error(
    `step "${key}" is not supported by the browser backend — it is terminal-only. ` +
      'Lint rule L008 should have caught this before capture.',
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/browser/steps.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backends/browser/steps.ts src/backends/browser/steps.test.ts
git commit -m "feat: browser step execution"
```

---

### Task 6: Browser assertions

**Files:**
- Create: `src/backends/browser/assertions.ts`
- Test: `src/backends/browser/assertions.test.ts`

**Interfaces:**
- Consumes: `BrowserSession` (Task 4), `AssertResult` (reused from `src/backends/terminal/assertions.js`), `compilePattern`
- Produces: `async function evaluateBrowserAssertion(assertion: Record<string, unknown>, session: BrowserSession): Promise<AssertResult>`

Supports `visible`, `hidden`, `text_matches`, `url_matches`, `no_console_errors`, `no_failed_requests`. Terminal assertions throw.

- [ ] **Step 1: Write the failing test**

Create `src/backends/browser/assertions.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserSession, type BrowserSession } from './session.js';
import { evaluateBrowserAssertion } from './assertions.js';

const PORT = 34570;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}, 30000);

afterAll(() => server.kill());

const open: BrowserSession[] = [];
const dirs: string[] = [];

async function session() {
  const dir = mkdtempSync(join(tmpdir(), 'castscript-ba-'));
  dirs.push(dir);
  const s = await openBrowserSession({ viewport: [640, 400], framesDir: join(dir, 'frames') });
  open.push(s);
  await s.goto(BASE);
  return s;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('evaluateBrowserAssertion', () => {
  it('visible passes for a shown element', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ visible: '[data-test=new-order]' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('visible fails for a hidden element and says so', async () => {
    const s = await session();
    const r = await evaluateBrowserAssertion({ visible: '.order-confirmed' }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('.order-confirmed');
  }, 60000);

  it('hidden passes for a hidden element', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ hidden: '.order-confirmed' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('url_matches honours a regex', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ url_matches: '/127\\.0\\.0\\.1/' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('text_matches searches the page text', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ text_matches: '/order desk/i' }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('no_console_errors passes on a clean page', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ no_console_errors: true }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('no_console_errors fails and reports the message', async () => {
    const s = await session();
    await s.page.evaluate(() => console.error('kaboom-in-page'));
    await s.page.waitForTimeout(200);
    const r = await evaluateBrowserAssertion({ no_console_errors: true }, s);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('kaboom-in-page');
  }, 60000);

  it('no_failed_requests passes when nothing failed', async () => {
    const s = await session();
    expect(await evaluateBrowserAssertion({ no_failed_requests: true }, s)).toMatchObject({
      ok: true,
    });
  }, 60000);

  it('throws on a terminal-only assertion', async () => {
    const s = await session();
    await expect(evaluateBrowserAssertion({ process_alive: true }, s)).rejects.toThrow(
      /terminal/i,
    );
  }, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backends/browser/assertions.test.ts`
Expected: FAIL — cannot resolve `./assertions.js`.

- [ ] **Step 3: Implement**

Create `src/backends/browser/assertions.ts`:

```ts
import { compilePattern } from '../../schema/pattern.js';
import type { AssertResult } from '../terminal/assertions.js';
import type { BrowserSession } from './session.js';

const VISIBILITY_TIMEOUT_MS = 5000;

export async function evaluateBrowserAssertion(
  assertion: Record<string, unknown>,
  session: BrowserSession,
): Promise<AssertResult> {
  const name = Object.keys(assertion)[0] ?? '(empty)';
  const fail = (detail: string): AssertResult => ({ name, ok: false, detail });
  const pass = (): AssertResult => ({ name, ok: true });
  const { page } = session;

  if (typeof assertion.visible === 'string') {
    const selector = assertion.visible;
    try {
      await page
        .locator(selector)
        .first()
        .waitFor({ state: 'visible', timeout: VISIBILITY_TIMEOUT_MS });
      return pass();
    } catch {
      const exists = (await page.locator(selector).count()) > 0;
      return fail(
        exists
          ? `${selector} exists but is not visible`
          : `${selector} is not present on the page`,
      );
    }
  }

  if (typeof assertion.hidden === 'string') {
    const selector = assertion.hidden;
    try {
      await page
        .locator(selector)
        .first()
        .waitFor({ state: 'hidden', timeout: VISIBILITY_TIMEOUT_MS });
      return pass();
    } catch {
      return fail(`${selector} is still visible`);
    }
  }

  if (typeof assertion.text_matches === 'string') {
    const source = assertion.text_matches;
    const re = compilePattern(source);
    if (re === null) return fail(`invalid regular expression: ${source}`);
    const text = (await page.locator('body').first().innerText()) ?? '';
    return re.test(text) ? pass() : fail(`${source} did not match the page text`);
  }

  if (typeof assertion.url_matches === 'string') {
    const source = assertion.url_matches;
    const re = compilePattern(source);
    if (re === null) return fail(`invalid regular expression: ${source}`);
    const url = page.url();
    return re.test(url) ? pass() : fail(`${source} did not match the url ${url}`);
  }

  if (assertion.no_console_errors !== undefined) {
    const errors = session.consoleErrors();
    return errors.length === 0
      ? pass()
      : fail(`${errors.length} console error(s):\n${errors.slice(0, 5).join('\n')}`);
  }

  if (assertion.no_failed_requests !== undefined) {
    const failed = session.failedRequests();
    return failed.length === 0
      ? pass()
      : fail(`${failed.length} failed request(s):\n${failed.slice(0, 5).join('\n')}`);
  }

  throw new Error(
    `assertion "${name}" is terminal-only and cannot run against a browser session. ` +
      'Lint rule L009 should have caught this before capture.',
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backends/browser/assertions.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backends/browser/assertions.ts src/backends/browser/assertions.test.ts
git commit -m "feat: browser assertions"
```

---

### Task 7: Teach the capture driver about browser sessions

**Files:**
- Modify: `src/driver/capture.ts`
- Modify: `src/driver/capture.test.ts`
- Create: `fixtures/browser/demo.yaml`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `CaptureArtifact` gains `frames: Record<string, FrameManifest>` alongside `casts`
  - `captureTerminalDemo` is renamed `captureDemo` and handles both backends; the old name is re-exported so existing callers keep working until Phase 2b updates them.
  - New option: `framesRoot?: string` — where browser frames are written (default `.castscript/frames`)

A demo whose sessions are all terminal must behave exactly as before.

- [ ] **Step 1: Write the browser fixture**

Create `fixtures/browser/demo.yaml`:

```yaml
castscript: 1
output:
  path: docs/browser-demo.mp4
  canvas: [1280, 720]
  fps: 30

defaults:
  settle: 250ms

sessions:
  web:
    backend: browser
    viewport: [1280, 720]

scenes:
  - id: open
    use: web
    narrate: "The order desk loads."
    steps:
      - goto: http://127.0.0.1:34600/
      - wait_for:
          selector: "[data-test=new-order]"
    assert:
      - visible: "[data-test=new-order]"
      - no_console_errors: true

  - id: order
    use: web
    narrate: "A customer places an order for three units."
    focus: "[data-test=order-form]"
    steps:
      - click: "[data-test=new-order]"
      - fill: { selector: "#qty", value: "3" }
      - click: "#submit"
      - wait_for:
          selector: ".order-confirmed"
    assert:
      - visible: ".order-confirmed"
      - text_matches: /3 unit/
      - no_failed_requests: true
```

- [ ] **Step 2: Write the failing test**

Append to `src/driver/capture.test.ts`:

```ts
describe('captureDemo with a browser session', () => {
  const PORT = 34600;
  let server: import('node:child_process').ChildProcess;

  beforeAll(async () => {
    const { spawn } = await import('node:child_process');
    server = spawn(process.execPath, ['fixtures/web-app/server.mjs', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      server.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('listening on')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }, 30000);

  afterAll(() => server.kill());

  it('captures browser scenes and stores frames', async () => {
    const { captureDemo } = await import('./capture.js');
    const result = await captureDemo(load('fixtures/browser/demo.yaml'));
    try {
      expect(result.scenes.map((s) => s.id)).toEqual(['open', 'order']);
      expect(result.ok, JSON.stringify(result.scenes, null, 2)).toBe(true);
      expect(result.frames.web).toBeDefined();
      expect(result.frames.web!.frames.length).toBeGreaterThan(0);
      expect(result.frames.web!.width).toBe(1280);
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync('.castscript', { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 180000);

  it('still captures a terminal-only demo unchanged', async () => {
    const { captureDemo } = await import('./capture.js');
    const result = await captureDemo(load('fixtures/terminal/demo.yaml'));
    expect(result.ok).toBe(true);
    expect(Object.keys(result.casts)).toEqual(['cli']);
    expect(Object.keys(result.frames)).toEqual([]);
  }, 120000);
});
```

Also add `beforeAll, afterAll` to the vitest import at the top of the file.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/driver/capture.test.ts`
Expected: FAIL — `captureDemo` is not exported.

- [ ] **Step 4: Implement**

Rewrite `src/driver/capture.ts` so it opens both kinds of session. Key changes:

```ts
import { join } from 'node:path';
import { evaluateBrowserAssertion } from '../backends/browser/assertions.js';
import type { FrameManifest } from '../backends/browser/frame-store.js';
import { openBrowserSession, type BrowserSession } from '../backends/browser/session.js';
import { executeBrowserStep } from '../backends/browser/steps.js';
```

Extend the artifact:

```ts
export interface CaptureArtifact {
  scenes: SceneCapture[];
  casts: Record<string, CastLog>;
  frames: Record<string, FrameManifest>;
  ok: boolean;
}

export interface CaptureOptions {
  now?: () => number;
  /** Where browser frames are written. */
  framesRoot?: string;
}
```

Replace the "browser arrives in Phase 2" guard with real session creation, keyed by backend:

```ts
type AnySession =
  | { kind: 'terminal'; id: string; session: TerminalSession }
  | { kind: 'browser'; id: string; session: BrowserSession };

const framesRoot = opts.framesRoot ?? join('.castscript', 'frames');
const sessions: AnySession[] = [];

for (const [id, config] of Object.entries(script.sessions)) {
  if (config.backend === 'terminal') {
    sessions.push({
      kind: 'terminal',
      id,
      session: await openTerminalSession({
        cols: config.cols ?? 80,
        rows: config.rows ?? 24,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.env === undefined ? {} : { env: config.env }),
        now,
      }),
    });
  } else {
    const session = await openBrowserSession({
      viewport: config.viewport ?? [1280, 720],
      framesDir: join(framesRoot, id),
      ...(config.attach?.cdp === undefined ? {} : { attachCdp: config.attach.cdp }),
    });
    await session.startCapture();
    sessions.push({ kind: 'browser', id, session });
  }
}
```

Dispatch steps and assertions by session kind:

```ts
const entry = sessions.find((s) => s.id === scene.use);
if (!entry) throw new Error(`scene "${scene.id}" uses unknown session "${scene.use}"`);

for (const step of scene.steps ?? []) {
  const result =
    entry.kind === 'terminal'
      ? await executeStep(step as Record<string, unknown>, {
          session: entry.session,
          seed: scene.id,
          typingSpeedMs,
          settleMs,
          now,
        })
      : await executeBrowserStep(step as Record<string, unknown>, {
          session: entry.session,
          settleMs,
          now,
        });
  steps.push(result);
  if (!result.ok) break;
}

for (const assertion of scene.assert ?? []) {
  assertions.push(
    entry.kind === 'terminal'
      ? await evaluateAssertion(assertion as Record<string, unknown>, entry.session)
      : await evaluateBrowserAssertion(assertion as Record<string, unknown>, entry.session),
  );
}
```

Apply `focus:` as in-browser zoom, since spec §4.5 puts zoom at capture time
for the browser:

```ts
if (entry.kind === 'browser' && scene.focus !== undefined) {
  const box = await entry.session.boundingBox(scene.focus);
  if (box === null) {
    // A focus selector that matches nothing is an authoring error lint
    // cannot catch, because it needs a live page. Record it as a scene
    // failure rather than silently rendering an unzoomed shot.
    assertions.push({
      name: 'focus',
      ok: false,
      detail: `focus selector ${scene.focus} matched no element`,
    });
  } else {
    // Phase 2a applies a flat scale. Phase 2b uses `box` to frame the
    // element and animates the scale across frames.
    await entry.session.setZoom(1.8);
  }
}
```

Place this **before** the step loop, so the zoom is in effect for the
frames the steps generate, and note that `assertions` must therefore be
declared before it.

Collect artifacts and tear down in reverse declaration order:

```ts
for (const entry of sessions) {
  if (entry.kind === 'terminal') casts[entry.id] = entry.session.cast();
  else frames[entry.id] = entry.session.manifest();
}
return { scenes, casts, frames, ok: scenes.every((s) => s.ok) };
```

```ts
} finally {
  for (const entry of [...sessions].reverse()) {
    if (entry.kind === 'terminal') {
      casts[entry.id] ??= entry.session.cast();
    } else {
      await entry.session.stopCapture().catch(() => undefined);
      frames[entry.id] ??= entry.session.manifest();
    }
    await entry.session.dispose().catch(() => undefined);
  }
}
```

Finally, rename and keep the old name working:

```ts
export async function captureDemo(
  script: DemoScript,
  opts: CaptureOptions = {},
): Promise<CaptureArtifact> { /* ... */ }

/** @deprecated Phase 1 name. Use captureDemo. */
export const captureTerminalDemo = captureDemo;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/driver/capture.test.ts
npx vitest run
npm run typecheck
```

Expected: all green. The Phase 1 render pipeline still passes because a
terminal-only script produces the same `casts` as before.

- [ ] **Step 6: Commit**

```bash
git add src/driver/capture.ts src/driver/capture.test.ts fixtures/browser/
git commit -m "feat: capture driver drives browser sessions alongside terminals"
```

---

### Task 8: Phase 2a acceptance

**Files:**
- Modify: `src/cli/acceptance.test.ts`

- [ ] **Step 1: Update the dependency assertion**

`playwright` is now a legitimate dependency:

```ts
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@fontsource/jetbrains-mono',
      '@napi-rs/canvas',
      '@xterm/headless',
      'node-pty',
      'playwright',
      'yaml',
      'zod',
    ]);
```

Rename the test from `carries no browser dependency yet` to
`carries no dependency beyond the declared set`.

- [ ] **Step 2: Add the phase 2a criterion**

```ts
describe('Phase 2a exit criteria', () => {
  it('validates the browser fixture', async () => {
    const c = captureIO();
    expect(await runCli(['validate', 'fixtures/browser/demo.yaml'], c.io)).toBe(0);
  });

  it('doctor reports chromium', async () => {
    const c = captureIO();
    await runCli(['doctor'], c.io);
    expect(c.out()).toContain('chromium');
  }, 60000);
});
```

- [ ] **Step 3: Run everything**

```bash
npx vitest run
npm run typecheck
npm run build
node dist/cli/index.js doctor
node dist/cli/index.js validate fixtures/browser/demo.yaml
```

Expected: all green; doctor lists chromium; the browser fixture validates.

- [ ] **Step 4: Verify no orphaned browsers**

```bash
tasklist //FI "IMAGENAME eq chrome.exe" //NH
```

Expected: no lingering Chromium from the test run.

- [ ] **Step 5: Commit**

```bash
git add src/cli/acceptance.test.ts
git commit -m "test: phase 2a acceptance"
```

---

## Phase 2a Definition of Done

- `npx vitest run` — all green, no `AttachConsole failed`, no unhandled rejections.
- `npm run typecheck` and `npm run build` — clean.
- `castscript doctor` reports a `chromium` row.
- `castscript validate fixtures/browser/demo.yaml` exits 0.
- `captureDemo` drives the browser fixture: two scenes, all assertions green, frames on disk with unix-second timestamps.
- A terminal-only demo captures exactly as it did in Phase 1, and the Phase 1 render pipeline still produces its mp4.
- No orphaned `chrome.exe` or `node.exe` processes after the suite.
- Runtime dependencies gain only `playwright`.

**Not in this plan (Phase 2b):** resampling frames to a fixed rate, the synthetic cursor, animated focus zoom, compositing browser frames onto the shared canvas, and rendering a browser demo to mp4.
