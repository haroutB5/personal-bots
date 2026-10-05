import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makePlaywrightDriver, SCREENCAST_PROFILES } from "./driver.ts";

const fake = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => void>();
  const send = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({}));
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
  fake.send.mockImplementation(async () => ({}));
});

const launch = () =>
  makePlaywrightDriver().launch({
    userDataDir: "test-profile",
    downloadsDir: "test-downloads",
    headless: true,
    executablePath: undefined,
    onDownloadSaved: () => {},
  });

const view = { pageX: 0, pageY: 4_000, clientWidth: 390, clientHeight: 760 };
const calls = (method: string) =>
  fake.send.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
const order = () => fake.send.mock.calls.map(([name]) => name);

/** Chrome answers the two calls a final frame needs; the rest return {} as before. */
const answerChrome = (
  shot: () => Promise<unknown> = async () => ({ data: "eA==" }),
  layout: unknown = view,
) => {
  fake.send.mockImplementation(async (method: string) => {
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: layout };
    if (method === "Page.captureScreenshot") return shot();
    return {};
  });
};

const started = async (onFrame = vi.fn()) => {
  const context = await launch();
  const page = context.pages()[0]!;
  const stop = await page.startScreencast(onFrame);
  fake.send.mockClear();
  return { page, onFrame, stop };
};

describe("screencast profiles (adaptive JPEG)", () => {
  it("starts sharp: quality 60, 780 px wide", async () => {
    const context = await launch();
    await context.pages()[0]!.startScreencast(vi.fn());
    expect(calls("Page.startScreencast")).toEqual([
      { format: "jpeg", quality: 60, maxWidth: 780, maxHeight: 1_690, everyNthFrame: 1 },
    ]);
  });

  it("moving is a smaller, rougher picture of the same shape", () => {
    expect(SCREENCAST_PROFILES.moving.quality).toBeLessThan(SCREENCAST_PROFILES.sharp.quality);
    expect(SCREENCAST_PROFILES.moving.maxWidth).toBeLessThan(SCREENCAST_PROFILES.sharp.maxWidth);
    expect(SCREENCAST_PROFILES.moving.maxHeight / SCREENCAST_PROFILES.moving.maxWidth).toBeCloseTo(
      SCREENCAST_PROFILES.sharp.maxHeight / SCREENCAST_PROFILES.sharp.maxWidth,
      1,
    );
  });

  it("does nothing while no screencast runs", async () => {
    const context = await launch();
    await context.pages()[0]!.setScreencastProfile!("moving");
    expect(fake.send).not.toHaveBeenCalledWith("Page.stopScreencast");
    expect(calls("Page.startScreencast")).toEqual([]);
  });

  it("goes rough with a stop and a start and no screenshot", async () => {
    answerChrome();
    const { page } = await started();
    await page.setScreencastProfile!("moving");
    expect(order()).toEqual(["Page.stopScreencast", "Page.startScreencast"]);
    expect(calls("Page.startScreencast")).toEqual([
      { format: "jpeg", quality: 38, maxWidth: 520, maxHeight: 1_130, everyNthFrame: 1 },
    ]);
  });

  it("asking for the profile it already has changes nothing", async () => {
    answerChrome();
    const { page } = await started();
    await page.setScreencastProfile!("sharp");
    expect(fake.send).not.toHaveBeenCalled();
    await page.setScreencastProfile!("moving");
    fake.send.mockClear();
    await page.setScreencastProfile!("moving");
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("going back to sharp sends one sharp frame of the page as it rests, then resumes", async () => {
    answerChrome();
    const { page, onFrame } = await started();
    await page.setScreencastProfile!("moving");
    fake.send.mockClear();
    await page.setScreencastProfile!("sharp");
    expect(order()).toEqual([
      "Page.stopScreencast",
      "Page.getLayoutMetrics",
      "Page.captureScreenshot",
      "Page.startScreencast",
    ]);
    // The part of the document the screen shows, at the size a sharp screencast frame has:
    // 390 x 760 css px at 2x is 780 x 1520, inside both caps.
    expect(calls("Page.captureScreenshot")).toEqual([
      {
        format: "jpeg",
        quality: 60,
        optimizeForSpeed: true,
        clip: { x: 0, y: 4_000, width: 390, height: 760, scale: 2 },
      },
    ]);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toEqual(Buffer.from("eA==", "base64"));
    // Tap mapping: the frame carries the page's css size and device scale, as a screencast frame does.
    expect(onFrame.mock.calls[0]![1]).toEqual({ width: 390, height: 760, deviceScaleFactor: 2 });
    expect(calls("Page.startScreencast")).toEqual([
      { format: "jpeg", quality: 60, maxWidth: 780, maxHeight: 1_690, everyNthFrame: 1 },
    ]);
  });

  it("scales the final frame down to the sharp caps, like Chrome does for a wide screen", async () => {
    answerChrome(async () => ({ data: "eA==" }), {
      pageX: 0,
      pageY: 0,
      clientWidth: 1_280,
      clientHeight: 720,
    });
    const { page } = await started();
    await page.setScreencastProfile!("moving");
    fake.send.mockClear();
    await page.setScreencastProfile!("sharp");
    const [shot] = calls("Page.captureScreenshot") as Array<{ clip: { scale: number } }>;
    expect(shot!.clip.scale).toBeCloseTo(780 / 1_280, 5);
  });

  it("resumes the sharp screencast even if the screenshot fails", async () => {
    answerChrome(async () => {
      throw new Error("Not attached to an active page");
    });
    const { page, onFrame } = await started();
    await page.setScreencastProfile!("moving");
    fake.send.mockClear();
    await page.setScreencastProfile!("sharp");
    expect(onFrame).not.toHaveBeenCalled();
    expect(order().at(-1)).toBe("Page.startScreencast");
  });

  it("does not wait on a screenshot that never comes back for more than the cap", async () => {
    vi.useFakeTimers();
    try {
      answerChrome(() => new Promise(() => {}));
      const { page, onFrame } = await started();
      await page.setScreencastProfile!("moving");
      fake.send.mockClear();
      const switching = page.setScreencastProfile!("sharp");
      await vi.advanceTimersByTimeAsync(1_499);
      expect(order()).not.toContain("Page.startScreencast");
      await vi.advanceTimersByTimeAsync(2);
      await switching;
      expect(order().at(-1)).toBe("Page.startScreencast");
      expect(onFrame).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the final frame and the restart when the screencast was stopped meanwhile", async () => {
    let finish: (value: unknown) => void = () => {};
    answerChrome(() => new Promise((resolve) => (finish = resolve)));
    const { page, onFrame, stop } = await started();
    await page.setScreencastProfile!("moving");
    fake.send.mockClear();
    const switching = page.setScreencastProfile!("sharp");
    await vi.waitFor(() => expect(order()).toContain("Page.captureScreenshot"));
    await stop();
    finish({ data: "eA==" });
    await switching;
    expect(onFrame).not.toHaveBeenCalled();
    expect(calls("Page.startScreencast")).toEqual([]);
  });

  it("applies calls in the order they came, one at a time", async () => {
    answerChrome();
    const { page, onFrame } = await started();
    const first = page.setScreencastProfile!("moving");
    const second = page.setScreencastProfile!("sharp");
    const third = page.setScreencastProfile!("moving");
    await Promise.all([first, second, third]);
    const starts = calls("Page.startScreencast") as Array<{ quality: number }>;
    expect(starts.map((start) => start.quality)).toEqual([38, 60, 38]);
    // The sharp one in the middle got its final frame; the last is rough, so none follows it.
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(order().at(-1)).toBe("Page.startScreencast");
  });

  it("frames of a rough screencast map taps exactly like sharp ones", async () => {
    answerChrome();
    const { page, onFrame } = await started();
    await page.setScreencastProfile!("moving");
    // A rough frame is smaller in pixels, but its metadata still describes the screen in css pixels.
    fake.listeners.get("Page.screencastFrame")!({
      data: "eA==",
      sessionId: 3,
      metadata: { deviceWidth: 390, deviceHeight: 760, pageScaleFactor: 1 },
    });
    expect(onFrame.mock.calls[0]![1]).toEqual({ width: 390, height: 760, deviceScaleFactor: 2 });
    expect(fake.send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 3 });
  });
});
