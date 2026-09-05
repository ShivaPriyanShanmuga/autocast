import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import type { CursorKeyframe, CursorPoint, ZoomKeyframe } from '../../render/cursor.js';
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
  recordPointer(at: CursorPoint, click: boolean): void;
  pointerTrack(): CursorKeyframe[];
  zoomTrack(): ZoomKeyframe[];
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
    // (spec section 4.5.1), so setting it would only mislead.
    context = await browser.newContext({ viewport: { width, height } });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  if (opts.attachCdp) await page.setViewportSize({ width, height });

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const pointerTrack: CursorKeyframe[] = [];
  const zoomTrack: ZoomKeyframe[] = [];
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
      // Recorded so the cursor overlay can follow the scale; without
      // this the pointer is drawn where it never was.
      zoomTrack.push({ tSec: Date.now() / 1000, scale });
    },

    async boundingBox(selector) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) return null;
      return locator.boundingBox();
    },

    consoleErrors: () => [...consoleErrors],
    failedRequests: () => [...failedRequests],

    recordPointer(at, click) {
      // Unix seconds, the same clock the screencast stamps frames with,
      // so the two timelines need no conversion to line up.
      pointerTrack.push({ tSec: Date.now() / 1000, at, ...(click ? { click: true } : {}) });
    },

    pointerTrack: () => [...pointerTrack],
    zoomTrack: () => [...zoomTrack],
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
