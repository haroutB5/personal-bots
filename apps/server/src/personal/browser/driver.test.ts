import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makePlaywrightDriver } from "./driver.ts";

const fake = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => void>();
  const send = vi.fn(async (_method: string, _params?: unknown) => ({}));
  const session = {
    send,
    on: vi.fn((name, listener) => listeners.set(name, listener)),
    off: vi.fn(),
  };
  const context = {
    pages: vi.fn(),
    newPage: vi.fn(),
    newCDPSession: vi.fn(async () => session),
    on: vi.fn(),
    close: vi.fn(),
  };
  const page = {
    on: vi.fn(),
    once: vi.fn(),
    context: () => context,
    evaluate: vi.fn(async () => 2),
    goto: vi.fn(),
    close: vi.fn(async () => undefined),
    isClosed: () => false,
    screenshot: vi.fn(async (_options?: unknown) => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  };
  context.pages.mockReturnValue([page]);
  context.newPage.mockResolvedValue(page);
  const launch = vi.fn(async (_profile: string, _options: Record<string, unknown>) => context);
  const browserSend = vi.fn(async (method: string, params?: { readonly url?: string }) => {
    if (method === "Target.createTarget") {
      shared.createdUrl = params?.url ?? "";
      return { targetId: "bot-target" };
    }
    return {};
  });
  const browserSession = { send: browserSend, detach: vi.fn(async () => undefined) };
  const shared = { createdUrl: "", pageEventArrives: true };
  const browser = {
    contexts: () => [context],
    newBrowserCDPSession: vi.fn(async () => browserSession),
    once: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const sharedPage = { ...page, url: () => shared.createdUrl, close: vi.fn(async () => undefined) };
  const waitForEvent = vi.fn(
    async (_event: string, options: { readonly predicate: (page: unknown) => boolean }) => {
      for (let tries = 0; tries < 20; tries++) {
        if (!shared.pageEventArrives) break;
        if (options.predicate(sharedPage)) return sharedPage;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Timeout 10000ms exceeded while waiting for event page");
    },
  );
  Object.assign(context, { waitForEvent });
  const connectOverCDP = vi.fn(
    async (_endpoint: string, _options: Record<string, unknown>) => browser,
  );
  return {
    listeners,
    send,
    context,
    page,
    launch,
    browser,
    browserSend,
    browserSession,
    shared,
    sharedPage,
    connectOverCDP,
  };
});

vi.mock("playwright-core", () => ({
  chromium: { launchPersistentContext: fake.launch, connectOverCDP: fake.connectOverCDP },
}));
vi.mock("./sharedBrowser.ts", () => ({
  resolveSharedEndpoint: async () => ({ wsEndpoint: "ws://127.0.0.1:1/devtools/browser/test" }),
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  access: async () => Promise.reject(new Error("ENOENT")),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fake.listeners.clear();
  fake.shared.createdUrl = "";
  fake.shared.pageEventArrives = true;
});

const BRAVE = "C:\\Apps\\Brave\\brave.exe";

const launch = () =>
  makePlaywrightDriver({ resolveExecutable: () => BRAVE }).launch({
    userDataDir: "test-profile",
    downloadsDir: "test-downloads",
    headless: true,
    executablePath: undefined,
    onDownloadSaved: () => {},
  });

describe("shared browser driver", () => {
  it("launches the resolved Brave executable and never a Chrome channel", async () => {
    await launch();
    expect(fake.launch).toHaveBeenCalledTimes(1);
    const [profile, options] = fake.launch.mock.calls[0]!;
    expect(profile).toBe("test-profile");
    expect(options).toMatchObject({ executablePath: BRAVE });
    expect(options).not.toHaveProperty("channel");
  });

  it("maps a shrunken desktop screencast into the page CSS coordinates Chrome accepts", async () => {
    const context = await launch();
    const frame = vi.fn();
    await context.pages()[0]!.startScreencast(frame);
    fake.listeners.get("Page.screencastFrame")!({
      data: "eA==",
      sessionId: 1,
      metadata: { deviceWidth: 390, deviceHeight: 560, pageScaleFactor: 390 / 980 },
    });
    expect(frame.mock.calls[0]![1].width).toBeCloseTo(980);
    expect(frame.mock.calls[0]![1].height).toBeCloseTo((560 * 980) / 390);
    expect(frame.mock.calls[0]![1].deviceScaleFactor).toBe(2);
  });

  it("keeps responsive and desktop frames at their original CSS size", async () => {
    const context = await launch();
    const frame = vi.fn();
    await context.pages()[0]!.startScreencast(frame);
    fake.listeners.get("Page.screencastFrame")!({
      data: "eA==",
      sessionId: 1,
      metadata: { deviceWidth: 390, deviceHeight: 560, pageScaleFactor: 1 },
    });
    expect(frame.mock.calls[0]![1]).toEqual({ width: 390, height: 560, deviceScaleFactor: 2 });
  });

  it("acks Chrome's frame at once, or once the consumer's promise settles", async () => {
    const context = await launch();
    const acks = () =>
      fake.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck").length;
    const event = {
      data: "eA==",
      sessionId: 7,
      metadata: { deviceWidth: 390, deviceHeight: 560 },
    };
    await context.pages()[0]!.startScreencast(vi.fn());
    fake.listeners.get("Page.screencastFrame")!(event);
    expect(acks()).toBe(1);
    expect(fake.send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 7 });

    let release: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    await context.pages()[0]!.startScreencast(slow);
    fake.listeners.get("Page.screencastFrame")!(event);
    await Promise.resolve();
    expect(acks()).toBe(1);
    release();
    // @effect-diagnostics-next-line globalTimers:off
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acks()).toBe(2);
  });

  it("still acks when the consumer throws or rejects, so Chrome never stalls", async () => {
    const context = await launch();
    const acks = () =>
      fake.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck").length;
    const event = {
      data: "eA==",
      sessionId: 8,
      metadata: { deviceWidth: 390, deviceHeight: 560 },
    };
    await context.pages()[0]!.startScreencast(() => {
      throw new Error("boom");
    });
    fake.listeners.get("Page.screencastFrame")!(event);
    expect(acks()).toBe(1);
    await context.pages()[0]!.startScreencast(() => Promise.reject(new Error("boom")));
    fake.listeners.get("Page.screencastFrame")!(event);
    // @effect-diagnostics-next-line globalTimers:off
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acks()).toBe(2);
  });

  it("sends a scroll step at a point as one Chrome call", async () => {
    const context = await launch();
    const page = context.pages()[0]!;
    await page.mouseWheelAt(12, 34, 0, 56);
    expect(fake.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 12,
      y: 34,
      deltaX: 0,
      deltaY: 56,
      modifiers: 0,
    });
  });

  it("isolates passkey requests before navigating every new page", async () => {
    const context = await launch();
    const page = await context.newPage();
    await page.goto("http://localhost/signin", { waitUntil: "commit", timeoutMs: 1000 });
    expect(fake.send).toHaveBeenCalledWith("WebAuthn.enable", { enableUI: false });
    expect(fake.send).toHaveBeenCalledWith("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: false,
        automaticPresenceSimulation: true,
      },
    });
    const authIndex = fake.send.mock.calls.findIndex(
      ([method]) => method === "WebAuthn.addVirtualAuthenticator",
    );
    expect(fake.send.mock.invocationCallOrder[authIndex]).toBeLessThan(
      fake.page.goto.mock.invocationCallOrder[0]!,
    );
  });

  it("owned pages never start a screencast or a focus override on their own", async () => {
    const context = await launch();
    const page = await context.newPage();
    await page.goto("http://localhost/signin", { waitUntil: "commit", timeoutMs: 1000 });
    await page.screenshotPng();
    const methods = fake.send.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("Page.startScreencast");
    expect(methods).not.toContain("Emulation.setFocusEmulationEnabled");
    expect(fake.context.newCDPSession).toHaveBeenCalledTimes(1);
    expect(fake.page.screenshot).toHaveBeenCalledWith({ type: "png", scale: "css" });
  });

  it("owned pages never send the focus override", async () => {
    const context = await launch();
    const page = await context.newPage();
    await page.goto("http://localhost/signin", { waitUntil: "commit", timeoutMs: 1000 });
    const methods = fake.send.mock.calls.map(([method]) => method);
    expect(methods).toContain("WebAuthn.enable");
    expect(methods).not.toContain("Emulation.setFocusEmulationEnabled");
  });
});

const attach = () => makePlaywrightDriver().attach({ userDataDir: "shared-profile" });

describe("shared bot tabs", () => {
  it("shared bot pages turn on the focus override before the first navigation", async () => {
    const handle = await attach();
    const page = await handle.newPage();
    await page.goto("http://localhost/signin", { waitUntil: "commit", timeoutMs: 1000 });
    expect(fake.send).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    const overrideIndex = fake.send.mock.calls.findIndex(
      ([method]) => method === "Emulation.setFocusEmulationEnabled",
    );
    expect(fake.send.mock.invocationCallOrder[overrideIndex]).toBeLessThan(
      fake.page.goto.mock.invocationCallOrder[0]!,
    );
  });

  it("shared bot pages start a tiny frame pump on its own session before the first navigation", async () => {
    const handle = await attach();
    const page = await handle.newPage();
    await page.goto("http://localhost/signin", { waitUntil: "commit", timeoutMs: 1000 });
    expect(fake.context.newCDPSession).toHaveBeenCalledTimes(2);
    const pumpCalls = fake.send.mock.calls.filter(([method]) => method === "Page.startScreencast");
    expect(pumpCalls).toEqual([
      [
        "Page.startScreencast",
        { format: "jpeg", quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 30 },
      ],
    ]);
    const pumpIndex = fake.send.mock.calls.findIndex(
      ([method]) => method === "Page.startScreencast",
    );
    expect(fake.send.mock.invocationCallOrder[pumpIndex]).toBeLessThan(
      fake.page.goto.mock.invocationCallOrder[0]!,
    );
  });

  it("the frame pump acknowledges every frame so it never stalls", async () => {
    const handle = await attach();
    const page = await handle.newPage();
    await page.goto("http://localhost/signin", { waitUntil: "commit", timeoutMs: 1000 });
    fake.listeners.get("Page.screencastFrame")!({ sessionId: 41, data: "" });
    await Promise.resolve();
    expect(fake.send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 41 });
  });

  it("a shared bot screenshot goes through page.screenshot, not a screencast grab", async () => {
    const handle = await attach();
    const page = await handle.newPage();
    const png = await page.screenshotPng();
    expect(fake.page.screenshot).toHaveBeenCalledWith({ type: "png", scale: "css" });
    expect(png).toBeInstanceOf(Uint8Array);
    const pngGrabs = fake.send.mock.calls.filter(
      ([method, params]) =>
        method === "Page.startScreencast" && (params as { format?: string }).format === "png",
    );
    expect(pngGrabs).toEqual([]);
  });

  it("opens the bot tab in the background at a nonce address and wraps that page", async () => {
    const handle = await attach();
    await handle.newPage();
    expect(fake.connectOverCDP).toHaveBeenCalledWith(
      "ws://127.0.0.1:1/devtools/browser/test",
      expect.objectContaining({ noDefaults: true }),
    );
    const created = fake.browserSend.mock.calls.filter(
      ([method]) => method === "Target.createTarget",
    );
    expect(created).toHaveLength(1);
    expect(created[0]![1]).toEqual({
      url: expect.stringMatching(/^about:blank#hbots-[0-9a-f-]{8,}$/),
      background: true,
    });
    expect(fake.context.newPage).not.toHaveBeenCalled();
    expect(handle.pages()).toHaveLength(1);
  });

  it("closes the new target and throws when its page never shows up", async () => {
    fake.shared.pageEventArrives = false;
    const handle = await attach();
    await expect(handle.newPage()).rejects.toThrow(/Timeout/);
    expect(fake.browserSend).toHaveBeenCalledWith("Target.closeTarget", {
      targetId: "bot-target",
    });
    expect(handle.pages()).toHaveLength(0);
  });

  it("detach closes the bot pages, then the browser session, then the connection", async () => {
    const handle = await attach();
    await handle.newPage();
    await handle.detach();
    expect(fake.sharedPage.close.mock.invocationCallOrder[0]).toBeLessThan(
      fake.browserSession.detach.mock.invocationCallOrder[0]!,
    );
    expect(fake.browserSession.detach.mock.invocationCallOrder[0]).toBeLessThan(
      fake.browser.close.mock.invocationCallOrder[0]!,
    );
  });
});
