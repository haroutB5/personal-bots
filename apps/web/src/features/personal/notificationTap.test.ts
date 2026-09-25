import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  TAP_POLL_INTERVAL_MS,
  TAP_WATCH_AFTER_PUSH_MS,
  createNotificationTapController,
  type PendingTap,
  type TapAck,
} from "./notificationTap";

const CHAT = "/bots/bot-1/thread-1";

function page(options: { path?: string; visible?: boolean } = {}) {
  const state = {
    path: options.path ?? "/bots",
    visible: options.visible ?? true,
    pending: null as PendingTap | null,
  };
  const navigate = vi.fn((path: string) => {
    state.path = path;
  });
  const acks: TapAck[] = [];
  const reports: Record<string, unknown>[] = [];
  const controller = createNotificationTapController({
    navigate,
    currentPath: () => state.path,
    takePending: async () => {
      const pending = state.pending;
      state.pending = null;
      return pending;
    },
    isVisible: () => state.visible,
    visibility: () => (state.visible ? "visible" : "hidden"),
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    ack: (ack) => acks.push(ack),
    report: (record) => reports.push(record),
  });
  return { state, navigate, acks, reports, controller };
}

describe("notification tap delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds a foreground tap by polling after the push, when both messages are dropped", async () => {
    // iOS, app in front: the banner tap fires no visibility or focus event and
    // the worker's messages never arrive. Only the saved copy is left.
    const app = page();
    app.controller.onMessage({ type: "bots:push-shown", at: Date.now() }, "broadcast");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(app.navigate).not.toHaveBeenCalled();

    app.state.pending = { url: CHAT, id: "tap-1" };
    await vi.advanceTimersByTimeAsync(TAP_POLL_INTERVAL_MS);

    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(CHAT);
    expect(app.acks).toEqual([
      { type: "bots:navigate-ack", id: "tap-1", via: "cache-poll", visibility: "visible" },
    ]);
    expect(app.reports).toEqual([
      expect.objectContaining({ event: "tap-received", id: "tap-1", via: "cache-poll" }),
    ]);
    app.controller.dispose();
  });

  it("navigates once when the same tap arrives by message, broadcast and saved copy", async () => {
    const app = page();
    app.state.pending = { url: CHAT, id: "tap-1" };
    const message = { type: "bots:navigate", url: CHAT, id: "tap-1" };
    app.controller.onMessage(message, "broadcast");
    app.controller.onMessage(message, "message");
    await app.controller.check("cache-focus");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(CHAT);
    expect(app.acks).toHaveLength(1);
    expect(app.acks[0]?.via).toBe("broadcast");
    // The saved copy was cleared, so a later resume cannot replay it.
    expect(app.state.pending).toBeNull();
    app.controller.dispose();
  });

  it("still delivers a newer tap saved while an older one was handled", async () => {
    const app = page();
    app.controller.onMessage({ type: "bots:navigate", url: CHAT, id: "tap-1" }, "message");
    app.state.pending = { url: "/bots/bot-2/thread-9", id: "tap-2" };
    await app.controller.check("cache-visible");
    expect(app.navigate.mock.calls).toEqual([[CHAT], ["/bots/bot-2/thread-9"]]);
  });

  it("catches a copy the worker saves after the app became visible", async () => {
    // Background tap: the page can wake before the worker has written the link.
    const app = page();
    await app.controller.check("cache-visible");
    expect(app.navigate).not.toHaveBeenCalled();
    app.state.pending = { url: CHAT, id: "tap-1" };
    await vi.advanceTimersByTimeAsync(TAP_POLL_INTERVAL_MS * 2);
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(CHAT);
    app.controller.dispose();
  });

  it("does not poll while hidden and stops watching after the window", async () => {
    const app = page({ visible: false });
    app.controller.onMessage({ type: "bots:push-shown" }, "message");
    app.state.pending = { url: CHAT, id: "tap-1" };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(app.navigate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TAP_WATCH_AFTER_PUSH_MS);
    app.state.visible = true;
    await vi.advanceTimersByTimeAsync(5_000);
    // The watch ended; the copy waits for the next visible/focus check.
    expect(app.navigate).not.toHaveBeenCalled();
    await app.controller.check("cache-visible");
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(CHAT);
    app.controller.dispose();
  });

  it("accepts an id-less message from an older worker and ignores unsafe links", () => {
    const app = page();
    app.controller.onMessage({ type: "bots:navigate", url: "//evil.example/x" }, "message");
    app.controller.onMessage({ type: "bots:navigate", url: "https://evil.example" }, "message");
    app.controller.onMessage(null, "message");
    expect(app.navigate).not.toHaveBeenCalled();

    app.controller.onMessage({ type: "bots:navigate", url: CHAT }, "message");
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(CHAT);
    // No id, nothing for the worker to match an ack against.
    expect(app.acks).toEqual([]);
  });

  it("acks but does not re-navigate when already on the chat", async () => {
    const app = page({ path: CHAT });
    app.controller.onMessage({ type: "bots:navigate", url: CHAT, id: "tap-1" }, "message");
    expect(app.navigate).not.toHaveBeenCalled();
    expect(app.acks).toHaveLength(1);
  });
});

describe("notification tap to another chat of the same bot", () => {
  // 25 Sep: in the CTO's "Hbots" chat, a tap on its "Tennis" reply. Only the
  // thread differs from the open path, and every route must still move there.
  const HBOTS = "/bots/969c2998-6725-4bf1-8c48-df9a6c75d46c/fd16ef6f-50dd-4230-bc62-2095fddc1f5a";
  const TENNIS = "/bots/969c2998-6725-4bf1-8c48-df9a6c75d46c/1537d615-648e-41bf-8022-1c71dc46a858";

  for (const via of ["message", "broadcast"] as const) {
    it(`opens the notified chat by ${via}`, () => {
      const app = page({ path: HBOTS });
      app.controller.onMessage({ type: "bots:navigate", url: TENNIS, id: `tap-${via}` }, via);
      expect(app.navigate).toHaveBeenCalledExactlyOnceWith(TENNIS);
      expect(app.reports[0]).toMatchObject({ event: "tap-received", navigated: true, via });
    });
  }

  for (const via of ["cache-load", "cache-focus", "cache-visible"] as const) {
    it(`opens the notified chat from the saved copy (${via})`, async () => {
      const app = page({ path: HBOTS });
      app.state.pending = { url: TENNIS, id: `tap-${via}` };
      await app.controller.check(via);
      expect(app.navigate).toHaveBeenCalledExactlyOnceWith(TENNIS);
      app.controller.dispose();
    });
  }
});
