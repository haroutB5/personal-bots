// @effect-diagnostics nodeBuiltinImport:off - Playwright boundary: download copies and the profile dir are plain Node I/O.
// @effect-diagnostics globalDate:off - page event callbacks run outside Effect and stamp wall-clock times.
/**
 * The narrow browser surface the personal browser uses. The Playwright
 * implementation below is the only one that launches Chrome; tests supply a
 * fake so they never start a browser.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type * as Playwright from "playwright-core";

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ScreencastMeta extends ViewportSize {
  readonly deviceScaleFactor: number;
}

export interface ConsoleRecord {
  readonly level: string;
  readonly text: string;
  readonly timestamp: string;
}

export interface NetworkRecord {
  readonly url: string;
  readonly method: string;
  readonly status: number | null;
  readonly failed: boolean;
  readonly errorText?: string;
  readonly timestamp: string;
}

export interface NavigationHistory {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export type WaitUntil = "load" | "domcontentloaded" | "commit";

/**
 * A handle to one already-resolved element. Unlike a locator it never
 * re-resolves, so a cross-document navigation between resolution and use
 * detaches it and the operation throws instead of retargeting the new page.
 */
export interface BrowserElementHandle {
  fill(text: string, timeoutMs: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface BrowserPage {
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  goto(
    url: string,
    options: { readonly waitUntil: WaitUntil; readonly timeoutMs: number },
  ): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  history(): Promise<NavigationHistory>;
  clickLocator(locator: string, timeoutMs: number): Promise<void>;
  countLocator(locator: string): Promise<number>;
  /** `null` when nothing matched within the timeout. */
  resolveElement(locator: string, timeoutMs: number): Promise<BrowserElementHandle | null>;
  typeText(input: {
    readonly locator: string | null;
    readonly text: string;
    readonly clear: boolean;
    readonly timeoutMs: number;
  }): Promise<void>;
  scrollLocator(locator: string, deltaX: number, deltaY: number, timeoutMs: number): Promise<void>;
  waitForLocator(locator: string, timeoutMs: number): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<void>;
  waitForUrlIncludes(fragment: string, timeoutMs: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshotPng(): Promise<Uint8Array>;
  accessibilityTree(): Promise<unknown>;
  /** `null` clears the override so the page follows the window again. */
  setViewport(size: ViewportSize | null): Promise<void>;
  viewportSize(): Promise<ViewportSize>;
  setColorScheme(scheme: "light" | "dark" | null): Promise<void>;
  bringToFront(): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  mouseDown(): Promise<void>;
  mouseUp(): Promise<void>;
  mouseClick(x: number, y: number): Promise<void>;
  mouseWheel(deltaX: number, deltaY: number): Promise<void>;
  keyPress(combo: string): Promise<void>;
  insertText(text: string): Promise<void>;
  consoleEntries(): ReadonlyArray<ConsoleRecord>;
  networkEntries(): ReadonlyArray<NetworkRecord>;
  /** Streams JPEG frames until the returned stop function runs. Frames are acked per frame. */
  startScreencast(
    onFrame: (jpeg: Uint8Array, meta: ScreencastMeta) => void,
  ): Promise<() => Promise<void>>;
  onClose(listener: () => void): void;
  close(): Promise<void>;
}

export interface BrowserContextHandle {
  pages(): ReadonlyArray<BrowserPage>;
  newPage(): Promise<BrowserPage>;
  /** Fires once when Chrome exits for any reason (crash, window closed, close()). */
  onClose(listener: () => void): void;
  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  readonly userDataDir: string;
  readonly headless: boolean;
  readonly executablePath: string | undefined;
  readonly downloadsDir: string;
  readonly onDownloadSaved: (file: { readonly name: string; readonly path: string }) => void;
}

export interface BrowserDriver {
  launch(options: BrowserLaunchOptions): Promise<BrowserContextHandle>;
}

const RING_LIMIT = 50;
const MAX_AX_NODES = 1_500;
const SCREENCAST_OPTIONS = {
  format: "jpeg",
  quality: 60,
  maxWidth: 780,
  maxHeight: 1_690,
  everyNthFrame: 1,
} as const;

const pushRing = <A>(ring: A[], value: A) => {
  ring.push(value);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
};

const safeDownloadName = (suggested: string): string => {
  const base = NodePath.basename(suggested)
    .replace(/[^\w.\- ()]+/g, "_")
    .slice(0, 120);
  return `${Date.now()}-${base.length > 0 ? base : "download"}`;
};

function wrapPlaywrightPage(page: Playwright.Page): BrowserPage {
  const consoleRing: ConsoleRecord[] = [];
  const networkRing: NetworkRecord[] = [];
  page.on("console", (message) =>
    pushRing(consoleRing, {
      level: message.type(),
      text: message.text().slice(0, 2_000),
      timestamp: new Date().toISOString(),
    }),
  );
  page.on("requestfinished", (request) => {
    void request
      .response()
      .then((response) =>
        pushRing(networkRing, {
          url: request.url().slice(0, 2_048),
          method: request.method(),
          status: response?.status() ?? null,
          failed: false,
          timestamp: new Date().toISOString(),
        }),
      )
      .catch(() => undefined);
  });
  page.on("requestfailed", (request) =>
    pushRing(networkRing, {
      url: request.url().slice(0, 2_048),
      method: request.method(),
      status: null,
      failed: true,
      errorText: request.failure()?.errorText ?? "failed",
      timestamp: new Date().toISOString(),
    }),
  );

  // Emulation overrides only live as long as the CDP session that set them,
  // so one control session per page carries emulation, AX and screencast.
  let control: Promise<Playwright.CDPSession> | null = null;
  const cdp = () => {
    control ??= page.context().newCDPSession(page);
    return control;
  };

  return {
    url: () => page.url(),
    title: () => page.title(),
    isClosed: () => page.isClosed(),
    goto: async (url, options) => {
      await page.goto(url, { waitUntil: options.waitUntil, timeout: options.timeoutMs });
    },
    goBack: async () => {
      await page.goBack({ waitUntil: "commit" });
    },
    goForward: async () => {
      await page.goForward({ waitUntil: "commit" });
    },
    reload: async () => {
      await page.reload({ waitUntil: "commit" });
    },
    history: async () => {
      const history = await (await cdp()).send("Page.getNavigationHistory");
      return {
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entries.length - 1,
      };
    },
    clickLocator: (locator, timeoutMs) =>
      page.locator(locator).first().click({ timeout: timeoutMs }),
    countLocator: (locator) => page.locator(locator).count(),
    resolveElement: async (locator, timeoutMs) => {
      const handle = await page
        .locator(locator)
        .first()
        .elementHandle({ timeout: timeoutMs })
        .catch(() => null);
      if (handle === null) return null;
      return {
        fill: (text, timeout) => handle.fill(text, { timeout }),
        dispose: () => handle.dispose(),
      };
    },
    typeText: async ({ locator, text, clear, timeoutMs }) => {
      if (locator !== null) {
        const target = page.locator(locator).first();
        if (clear) {
          await target.fill(text, { timeout: timeoutMs });
          return;
        }
        await target.focus({ timeout: timeoutMs });
      } else if (clear) {
        await page.keyboard.press("ControlOrMeta+A");
      }
      if (text.length > 0) await page.keyboard.insertText(text);
      else if (clear) await page.keyboard.press("Delete");
    },
    scrollLocator: async (locator, deltaX, deltaY, timeoutMs) => {
      await page
        .locator(locator)
        .first()
        .evaluate(
          (element, delta) => element.scrollBy(delta[0], delta[1]),
          [deltaX, deltaY] as const,
          { timeout: timeoutMs },
        );
    },
    waitForLocator: (locator, timeoutMs) =>
      page.locator(locator).first().waitFor({ state: "visible", timeout: timeoutMs }),
    waitForText: async (text, timeoutMs) => {
      await page.waitForFunction(
        (needle: string) => {
          // Runs in the page; typed structurally because the server has no DOM lib.
          const page = globalThis as { document?: { body?: { innerText?: string } | null } };
          return (page.document?.body?.innerText ?? "").includes(needle);
        },
        text,
        { timeout: timeoutMs },
      );
    },
    waitForUrlIncludes: (fragment, timeoutMs) =>
      page.waitForURL((url) => url.href.includes(fragment), { timeout: timeoutMs }),
    evaluate: (expression) => page.evaluate(expression),
    screenshotPng: async () => new Uint8Array(await page.screenshot({ type: "png", scale: "css" })),
    accessibilityTree: async () => {
      const tree = await (await cdp()).send("Accessibility.getFullAXTree");
      return {
        nodes: tree.nodes.slice(0, MAX_AX_NODES),
        truncated: tree.nodes.length > MAX_AX_NODES,
      };
    },
    setViewport: async (size) => {
      const session = await cdp();
      if (size === null) {
        await session.send("Emulation.clearDeviceMetricsOverride");
        return;
      }
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 0,
        mobile: false,
      });
    },
    viewportSize: async () =>
      (await page.evaluate(
        "({ width: window.innerWidth, height: window.innerHeight })",
      )) as ViewportSize,
    setColorScheme: (scheme) => page.emulateMedia({ colorScheme: scheme }),
    bringToFront: () => page.bringToFront(),
    mouseMove: (x, y) => page.mouse.move(x, y),
    mouseDown: () => page.mouse.down(),
    mouseUp: () => page.mouse.up(),
    mouseClick: (x, y) => page.mouse.click(x, y),
    mouseWheel: (deltaX, deltaY) => page.mouse.wheel(deltaX, deltaY),
    keyPress: (combo) => page.keyboard.press(combo),
    insertText: (text) => page.keyboard.insertText(text),
    consoleEntries: () => [...consoleRing],
    networkEntries: () => [...networkRing],
    startScreencast: async (onFrame) => {
      const session = await cdp();
      const deviceScaleFactor = Number(await page.evaluate("window.devicePixelRatio")) || 1;
      const listener = (event: {
        readonly data: string;
        readonly sessionId: number;
        readonly metadata: { readonly deviceWidth: number; readonly deviceHeight: number };
      }) => {
        void session
          .send("Page.screencastFrameAck", { sessionId: event.sessionId })
          .catch(() => {});
        onFrame(Buffer.from(event.data, "base64"), {
          width: event.metadata.deviceWidth,
          height: event.metadata.deviceHeight,
          deviceScaleFactor,
        });
      };
      session.on("Page.screencastFrame", listener);
      await session.send("Page.startScreencast", SCREENCAST_OPTIONS);
      return async () => {
        session.off("Page.screencastFrame", listener);
        await session.send("Page.stopScreencast").catch(() => {});
      };
    },
    onClose: (listener) => {
      page.once("close", listener);
    },
    close: () => page.close(),
  };
}

/** Real Chrome via playwright-core. Loaded lazily so tests never import it. */
export const makePlaywrightDriver = (): BrowserDriver => ({
  launch: async (options) => {
    const { chromium } = await import("playwright-core");
    await NodeFSP.mkdir(options.userDataDir, { recursive: true });
    await NodeFSP.mkdir(options.downloadsDir, { recursive: true });
    const context = await chromium.launchPersistentContext(options.userDataDir, {
      ...(options.executablePath === undefined
        ? { channel: "chrome" }
        : { executablePath: options.executablePath }),
      headless: options.headless,
      // Follow the real window; per-tab overrides go through CDP emulation.
      viewport: null,
      acceptDownloads: true,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const wrappers = new WeakMap<Playwright.Page, BrowserPage>();
    const wrap = (page: Playwright.Page) => {
      let wrapped = wrappers.get(page);
      if (wrapped === undefined) {
        wrapped = wrapPlaywrightPage(page);
        wrappers.set(page, wrapped);
      }
      return wrapped;
    };
    const watchDownloads = (page: Playwright.Page) => {
      // Playwright deletes its own download temp files when the context
      // closes, so each download is copied into the artifacts directory.
      page.on("download", (download) => {
        const target = NodePath.join(
          options.downloadsDir,
          safeDownloadName(download.suggestedFilename()),
        );
        void download
          .saveAs(target)
          .then(() => options.onDownloadSaved({ name: NodePath.basename(target), path: target }))
          .catch(() => undefined);
      });
    };
    context.pages().forEach(watchDownloads);
    context.on("page", watchDownloads);
    return {
      pages: () => context.pages().map(wrap),
      newPage: async () => wrap(await context.newPage()),
      onClose: (listener) => {
        context.once("close", listener);
      },
      close: () => context.close(),
    };
  },
});
