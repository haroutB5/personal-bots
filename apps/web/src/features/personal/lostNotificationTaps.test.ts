import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  LOST_TAP_GRACE_MS,
  SHOWN_NOTIFICATIONS_MAX_AGE_MS,
  reconcileShown,
  type ShownNotification,
} from "./lostNotificationTaps";
import { createNotificationTapController, type PendingTap } from "./notificationTap";

const CTO_CHAT = "/bots/cto/thread-cto";
const ASSISTANT_TASK = "/tasks/task-assistant";
const ASSISTANT_CHAT = "/bots/personal-seed-assistant/thread-assistant";

function shown(key: string, url: string, at = Date.now()): ShownNotification {
  return { key, url, at };
}

describe("reconcileShown", () => {
  it("names the one notification that left Notification Center", () => {
    const now = Date.now();
    const result = reconcileShown(
      [shown("task-a", ASSISTANT_TASK, now - 60_000), shown("chat-b", CTO_CHAT, now - 30_000)],
      ["chat-b"],
      now,
    );
    expect(result.tapped).toEqual(shown("task-a", ASSISTANT_TASK, now - 60_000));
    expect(result.kept).toEqual([shown("chat-b", CTO_CHAT, now - 30_000)]);
  });

  it("guesses nothing when several left at once (Clear All)", () => {
    const now = Date.now();
    const result = reconcileShown(
      [shown("task-a", ASSISTANT_TASK, now), shown("chat-b", CTO_CHAT, now)],
      [],
      now,
    );
    expect(result.tapped).toBeNull();
    expect(result.kept).toEqual([]);
  });

  it("guesses nothing when every notification is still there", () => {
    const now = Date.now();
    const result = reconcileShown([shown("task-a", ASSISTANT_TASK, now)], ["task-a"], now);
    expect(result.tapped).toBeNull();
    expect(result.kept).toHaveLength(1);
  });

  it("forgets old entries without treating them as taps", () => {
    const now = Date.now();
    const result = reconcileShown(
      [shown("task-a", ASSISTANT_TASK, now - SHOWN_NOTIFICATIONS_MAX_AGE_MS - 1)],
      [],
      now,
    );
    expect(result.tapped).toBeNull();
    expect(result.kept).toEqual([]);
  });

  it("ignores entries that are not safe in-app paths", () => {
    const now = Date.now();
    const result = reconcileShown([shown("x", "https://evil.example/", now)], [], now);
    expect(result.tapped).toBeNull();
  });
});

function resumedPage(options: { path: string; lostTap: string | null }) {
  const state = {
    path: options.path,
    visible: true,
    pending: null as PendingTap | null,
    lostTap: options.lostTap,
  };
  const navigate = vi.fn((path: string) => {
    state.path = path;
  });
  const reports: Record<string, unknown>[] = [];
  const findLostTap = vi.fn(async () => {
    const url = state.lostTap;
    state.lostTap = null;
    return url;
  });
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
    ack: () => undefined,
    report: (record) => reports.push(record),
    lostTap: {
      find: findLostTap,
      after: (callback, ms) => void setTimeout(callback, ms),
    },
  });
  return { state, navigate, reports, controller, findLostTap };
}

describe("a tap iOS never hands to the worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the tapped Assistant notification, not the CTO chat the app was left on", async () => {
    // 30 Sep 17:49: the app resumed on CTO's chat after an Assistant task
    // notification was tapped, and no notificationclick ever reached the worker.
    const app = resumedPage({ path: CTO_CHAT, lostTap: ASSISTANT_TASK });
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);

    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_TASK);
    expect(app.reports).toEqual([
      expect.objectContaining({ event: "tap-received", url: ASSISTANT_TASK, via: "inferred" }),
    ]);
    app.controller.dispose();
  });

  it("opens a chat notification from a bot on the other team the same way", async () => {
    const app = resumedPage({ path: CTO_CHAT, lostTap: ASSISTANT_CHAT });
    await app.controller.check("cache-load");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_CHAT);
    app.controller.dispose();
  });

  it("lets a real tap win and does not guess on top of it", async () => {
    const app = resumedPage({ path: CTO_CHAT, lostTap: ASSISTANT_TASK });
    await app.controller.check("cache-visible");
    app.controller.onMessage(
      { type: "bots:navigate", url: ASSISTANT_CHAT, id: "tap-1" },
      "broadcast",
    );
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_CHAT);
    // The list is still reconciled, so the tapped entry is not guessed later.
    expect(app.findLostTap).toHaveBeenCalledOnce();
    app.controller.dispose();
  });

  it("stays put when nothing left Notification Center (opened from the icon)", async () => {
    const app = resumedPage({ path: CTO_CHAT, lostTap: null });
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.navigate).not.toHaveBeenCalled();
    app.controller.dispose();
  });

  it("looks once per return, however many resume events fire", async () => {
    const app = resumedPage({ path: CTO_CHAT, lostTap: null });
    await app.controller.check("cache-visible");
    await app.controller.check("cache-pageshow");
    await app.controller.check("cache-focus");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.findLostTap).toHaveBeenCalledOnce();
    app.controller.dispose();
  });

  it("does not look on a mere focus change", async () => {
    const app = resumedPage({ path: CTO_CHAT, lostTap: ASSISTANT_TASK });
    await app.controller.check("cache-focus");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.findLostTap).not.toHaveBeenCalled();
    app.controller.dispose();
  });
});
