// @effect-diagnostics nodeBuiltinImport:off - Playwright boundary: download copies and the profile dir are plain Node I/O.
// @effect-diagnostics globalDate:off - page event callbacks run outside Effect and stamp wall-clock times.
// @effect-diagnostics globalTimers:off - probe deadlines race plain Playwright promises.
/**
 * The narrow browser surface the personal browser uses. The Playwright
 * implementation below is the only one that launches Chrome; tests supply a
 * fake so they never start a browser.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type * as Playwright from "playwright-core";

import { keepBrowserPriorityNormal } from "./browserPriority.ts";

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** A device-metrics override. Defaults keep the window's own scale, desktop mode. */
export interface ViewportOverride extends ViewportSize {
  readonly deviceScaleFactor?: number;
  readonly mobile?: boolean;
}

export interface ScreencastMeta extends ViewportSize {
  readonly deviceScaleFactor: number;
}

/**
 * How a screencast is encoded. `sharp` is the resting picture; `moving` is a smaller, rougher
 * one for while the page scrolls (it is replaced by a sharp frame once the page settles).
 */
export type ScreencastProfile = "sharp" | "moving";

export const SCREENCAST_PROFILES = {
  sharp: { quality: 60, maxWidth: 780, maxHeight: 1_690 },
  moving: { quality: 38, maxWidth: 520, maxHeight: 1_130 },
} as const satisfies Record<
  ScreencastProfile,
  { readonly quality: number; readonly maxWidth: number; readonly maxHeight: number }
>;

/** The longest a final sharp screenshot may take before the sharp screencast resumes without it. */
const FINAL_FRAME_CAP_MS = 1_500;

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
 * A native JavaScript dialog (alert, confirm, prompt, beforeunload). While one
 * is open the page's main thread is parked inside it, so every page read and
 * input waits until someone answers it.
 */
export interface PageDialog {
  readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
  readonly message: string;
  readonly defaultValue: string;
}

/** What `unstick` found: a live page, a runaway script it stopped, or neither. */
export type UnstickOutcome = "responsive" | "stopped-script" | "unresponsive";

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
  setViewport(size: ViewportOverride | null): Promise<void>;
  viewportSize(): Promise<ViewportSize>;
  setColorScheme(scheme: "light" | "dark" | null): Promise<void>;
  bringToFront(): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  mouseDown(): Promise<void>;
  mouseUp(): Promise<void>;
  mouseClick(x: number, y: number): Promise<void>;
  mouseWheel(deltaX: number, deltaY: number): Promise<void>;
  /**
   * A wheel turn at a point in one call: the same `Input.dispatchMouseEvent` that
   * `mouse.wheel` sends after `mouse.move`, without the move. Nothing in the page
   * sees the pointer arrive first, and Playwright's own pointer position stays put.
   */
  mouseWheelAt(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  keyPress(combo: string): Promise<void>;
  insertText(text: string): Promise<void>;
  consoleEntries(): ReadonlyArray<ConsoleRecord>;
  networkEntries(): ReadonlyArray<NetworkRecord>;
  /**
   * Streams JPEG frames until the returned stop function runs. Chrome gets its
   * ack for a frame when `onFrame` returns, or, if it returns a promise, when
   * that settles. Chrome keeps at most two frames unacknowledged and a page change
   * that finds two out is not rendered later, so a consumer that holds acks costs
   * frames (and can lose the last one): settle the promise as soon as the frame is
   * written, replaced or dropped.
   */
  startScreencast(
    onFrame: (jpeg: Uint8Array, meta: ScreencastMeta) => void | Promise<void>,
  ): Promise<() => Promise<void>>;
  /**
   * Re-encodes the running screencast: `moving` is smaller and rougher, `sharp` the resting
   * picture. Going back to `sharp` also sends one sharp frame of what is on screen now (a page
   * that has stopped changing sends no frame of its own, so it would stay rough). A no-op while
   * no screencast runs or the profile is the one it has; calls are applied in order. Optional:
   * a page that lacks it streams one profile.
   */
  setScreencastProfile?(profile: ScreencastProfile): Promise<void>;
  onClose(listener: () => void): void;
  /** Main-frame origin changes, including an away-and-back navigation. */
  onOriginChange?(listener: () => void): void;
  /** The native dialog blocking this page, or null. Dialogs are never answered on their own. */
  pendingDialog(): PageDialog | null;
  /** Fires when a native dialog opens, and with null when it closes. Returns an unsubscribe. */
  onDialogChange(listener: (dialog: PageDialog | null) => void): () => void;
  /** Answers the open dialog. False when none was open (it may have closed meanwhile). */
  answerDialog(accept: boolean, promptText?: string): Promise<boolean>;
  /**
   * Called after an operation timed out: checks the page still answers, and if
   * a script is spinning on its main thread, stops it so the page does again.
   */
  unstick(probeMs: number): Promise<UnstickOutcome>;
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
const screencastOptions = (profile: ScreencastProfile) =>
  ({ format: "jpeg", ...SCREENCAST_PROFILES[profile], everyNthFrame: 1 }) as const;

const TIMED_OUT = Symbol("timed-out");

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
    control ??= page
      .context()
      .newCDPSession(page)
      .then(async (session) => {
        // Windows passkey dialogs run above the remote helper's integrity level.
        // An empty, unverified authenticator rejects sign-in in the page instead
        // of handing it to Windows Security. Keep it on this page's CDP session.
        await session.send("WebAuthn.enable", { enableUI: false });
        await session.send("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: false,
            automaticPresenceSimulation: true,
          },
        });
        return session;
      });
    return control;
  };

  // With no "dialog" listener Playwright dismisses every dialog itself, which
  // silently answers Cancel to a confirm the bot never saw. Holding it open
  // instead lets the bot report it and a person answer it.
  let dialog: { readonly handle: Playwright.Dialog; readonly info: PageDialog } | null = null;
  const dialogListeners: Array<(dialog: PageDialog | null) => void> = [];
  const setDialog = (next: typeof dialog) => {
    if (dialog === next) return;
    dialog = next;
    for (const listener of dialogListeners) listener(next?.info ?? null);
  };
  page.on("dialog", (opened) => {
    setDialog({
      handle: opened,
      info: {
        type: opened.type() as PageDialog["type"],
        message: opened.message().slice(0, 2_000),
        defaultValue: opened.defaultValue().slice(0, 2_000),
      },
    });
  });
  page.once("close", () => setDialog(null));
  // Someone answering it in the headed window closes it without us. Closes
  // we caused are skipped: a page that opens its next dialog straight away
  // would otherwise have that one cleared by the late event for the first.
  let ownCloses = 0;
  void cdp()
    .then(async (session) => {
      session.on("Page.javascriptDialogClosed", () => {
        if (ownCloses > 0) ownCloses--;
        else setDialog(null);
      });
      await session.send("Page.enable");
    })
    .catch(() => undefined);

  const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A | typeof TIMED_OUT> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const answers = (ms: number) =>
    withTimeout(
      page.evaluate("1").then(
        () => true,
        () => false,
      ),
      ms,
    ).then((result) => result === true);

  // The running screencast, if any, for `setScreencastProfile`. Switching profiles is a stop and a
  // start (Chrome has no way to change the quality of a running one): two quick calls, applied in
  // order, one at a time.
  interface ActiveScreencast {
    readonly session: Playwright.CDPSession;
    profile: ScreencastProfile;
    readonly deviceScaleFactor: number;
    readonly deliver: (jpeg: Uint8Array, meta: ScreencastMeta) => void;
  }
  let activeScreencast: ActiveScreencast | null = null;
  let screencastChain: Promise<void> = Promise.resolve();

  /** One sharp frame of what is on screen now, in the size a sharp screencast frame would have. */
  const sendFinalFrame = async (state: ActiveScreencast) => {
    const { session } = state;
    const { cssVisualViewport: view } = await session.send("Page.getLayoutMetrics");
    if (view.clientWidth <= 0 || view.clientHeight <= 0) return;
    const sharp = SCREENCAST_PROFILES.sharp;
    // Chrome never scales a screencast frame up past the screen's own pixels.
    const scale = Math.min(
      state.deviceScaleFactor,
      sharp.maxWidth / view.clientWidth,
      sharp.maxHeight / view.clientHeight,
    );
    const shot = await withTimeout(
      session.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: sharp.quality,
        optimizeForSpeed: true,
        // In document coordinates: the part of the page the screen shows.
        clip: {
          x: view.pageX,
          y: view.pageY,
          width: view.clientWidth,
          height: view.clientHeight,
          scale,
        },
      }),
      FINAL_FRAME_CAP_MS,
    );
    // A stopped screencast, or a profile asked for since, makes the picture stale.
    if (shot === TIMED_OUT || activeScreencast !== state || state.profile !== "sharp") return;
    state.deliver(Buffer.from(shot.data, "base64"), {
      width: view.clientWidth,
      height: view.clientHeight,
      deviceScaleFactor: state.deviceScaleFactor,
    });
  };

  const switchScreencastProfile = async (profile: ScreencastProfile) => {
    const state = activeScreencast;
    if (state === null || state.profile === profile) return;
    state.profile = profile;
    await state.session.send("Page.stopScreencast").catch(() => {});
    if (profile === "sharp") await sendFinalFrame(state).catch(() => {});
    // Stopped for good, or switched again while this one ran: nothing to start.
    if (activeScreencast !== state || state.profile !== profile) return;
    await state.session.send("Page.startScreencast", screencastOptions(profile)).catch(() => {});
  };

  return {
    url: () => page.url(),
    title: () => page.title(),
    isClosed: () => page.isClosed(),
    goto: async (url, options) => {
      await cdp();
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
    evaluate: async (expression) => {
      await cdp();
      return page.evaluate(expression);
    },
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
        deviceScaleFactor: size.deviceScaleFactor ?? 0,
        mobile: size.mobile ?? false,
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
    mouseWheelAt: async (x, y, deltaX, deltaY) => {
      const session = await cdp();
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        modifiers: 0,
      });
    },
    keyPress: (combo) => page.keyboard.press(combo),
    insertText: (text) => page.keyboard.insertText(text),
    consoleEntries: () => [...consoleRing],
    networkEntries: () => [...networkRing],
    startScreencast: async (onFrame) => {
      const session = await cdp();
      const deviceScaleFactor = Number(await page.evaluate("window.devicePixelRatio")) || 1;
      // One frame to the consumer. `ack` tells Chrome it may send the next; a frame that did not
      // come from Chrome's screencast has nothing to ack.
      const deliver = (jpeg: Uint8Array, meta: ScreencastMeta, ack: () => void) => {
        let handedOff: void | Promise<void>;
        try {
          handedOff = onFrame(jpeg, meta);
        } catch {
          handedOff = undefined;
        }
        // Chrome sends the next frame only after this ack, so holding it until
        // the consumer has taken the frame stops Chrome rendering frames that
        // would be thrown away.
        if (handedOff === undefined) ack();
        else void handedOff.then(ack, ack);
      };
      const listener = (event: {
        readonly data: string;
        readonly sessionId: number;
        readonly metadata: {
          readonly deviceWidth: number;
          readonly deviceHeight: number;
          readonly pageScaleFactor?: number;
        };
      }) => {
        // A desktop-width page without a mobile viewport shrinks into the
        // device. CDP mouse coordinates still use its layout CSS pixels.
        const scale = event.metadata.pageScaleFactor ?? 1;
        const pageScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
        deliver(
          Buffer.from(event.data, "base64"),
          {
            width: event.metadata.deviceWidth / pageScale,
            height: event.metadata.deviceHeight / pageScale,
            deviceScaleFactor,
          },
          () => {
            void session
              .send("Page.screencastFrameAck", { sessionId: event.sessionId })
              .catch(() => {});
          },
        );
      };
      const state: ActiveScreencast = {
        session,
        profile: "sharp",
        deviceScaleFactor,
        deliver: (jpeg, meta) => deliver(jpeg, meta, () => {}),
      };
      activeScreencast = state;
      session.on("Page.screencastFrame", listener);
      await session.send("Page.startScreencast", screencastOptions("sharp"));
      return async () => {
        if (activeScreencast === state) activeScreencast = null;
        session.off("Page.screencastFrame", listener);
        await session.send("Page.stopScreencast").catch(() => {});
      };
    },
    setScreencastProfile: (profile) => {
      const run = screencastChain.then(() => switchScreencastProfile(profile));
      screencastChain = run.catch(() => undefined);
      return run;
    },
    onClose: (listener) => {
      page.once("close", listener);
    },
    onOriginChange: (listener) => {
      let previous = new URL(page.url()).origin;
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        const next = new URL(frame.url()).origin;
        if (next !== previous) {
          previous = next;
          listener();
        }
      });
    },
    pendingDialog: () => dialog?.info ?? null,
    onDialogChange: (listener) => {
      dialogListeners.push(listener);
      return () => {
        const index = dialogListeners.indexOf(listener);
        if (index !== -1) dialogListeners.splice(index, 1);
      };
    },
    answerDialog: async (accept, promptText) => {
      const open = dialog;
      if (open === null) return false;
      ownCloses++;
      try {
        if (accept) await open.handle.accept(promptText);
        else await open.handle.dismiss();
        return true;
      } catch {
        // Already answered elsewhere, or the page went away with it.
        ownCloses = Math.max(0, ownCloses - 1);
        return false;
      } finally {
        if (dialog === open) setDialog(null);
      }
    },
    unstick: async (probeMs) => {
      if (page.isClosed() || dialog !== null) return "unresponsive";
      if (await answers(probeMs)) return "responsive";
      // A script spinning on the main thread starves every CDP call that
      // needs the page. Terminating it is what a person does with "Page
      // unresponsive > Stop"; the page keeps its DOM and answers again.
      const session = await withTimeout(cdp(), probeMs);
      if (session === TIMED_OUT) return "unresponsive";
      await withTimeout(
        session.send("Runtime.terminateExecution").catch(() => undefined),
        probeMs,
      );
      return (await answers(probeMs)) ? "stopped-script" : "unresponsive";
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
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        // Covers the brief CDP attach window of a script-opened popup too.
        "--disable-features=WebAuthenticationUseNativeWinApi",
      ],
    });
    // Off the launch path: the process list takes a second or two to read.
    void keepBrowserPriorityNormal(options.executablePath).catch(() => undefined);
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
    // Wrapped as they appear, so every page holds its dialogs open for
    // someone to answer rather than Playwright dismissing them unseen.
    context.pages().forEach(wrap);
    context.on("page", wrap);
    // Finish interception before exposing initial or newly-created pages.
    await Promise.all(context.pages().map((page) => wrap(page).evaluate("undefined")));
    return {
      pages: () => context.pages().map(wrap),
      newPage: async () => {
        const page = wrap(await context.newPage());
        await page.evaluate("undefined");
        return page;
      },
      onClose: (listener) => {
        context.once("close", listener);
      },
      close: () => context.close(),
    };
  },
});
