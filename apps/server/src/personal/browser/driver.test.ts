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
    isClosed: () => false,
  };
  context.pages.mockReturnValue([page]);
  context.newPage.mockResolvedValue(page);
  const launch = vi.fn(async () => context);
  return { listeners, send, context, page, launch };
});

vi.mock("playwright-core", () => ({ chromium: { launchPersistentContext: fake.launch } }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  fake.listeners.clear();
});

const launch = () =>
  makePlaywrightDriver().launch({
    userDataDir: "test-profile",
    downloadsDir: "test-downloads",
    headless: true,
    executablePath: undefined,
    onDownloadSaved: () => {},
  });

describe("shared browser driver", () => {
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
});
