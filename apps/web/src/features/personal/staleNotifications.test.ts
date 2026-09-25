import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createNotificationTapController } from "./notificationTap";
import {
  CLEAR_STALE_NOTIFICATIONS_DELAY_MS,
  type ClosableNotification,
  closeNotifications,
  createDeferredNotificationClear,
  isChatNotification,
  notificationUrl,
  type StaleClearReason,
} from "./staleNotifications";

const note = (fields: { tag?: string; url?: string; closeThrows?: boolean }) => {
  const close = vi.fn(() => {
    if (fields.closeThrows) throw new Error("refused");
  });
  const notification: ClosableNotification = {
    ...(fields.tag === undefined ? {} : { tag: fields.tag }),
    data: fields.url === undefined ? null : { url: fields.url },
    close,
  };
  return { notification, close };
};

describe("stale notifications", () => {
  it("closes every notification when the app comes to the front, and counts them", async () => {
    const a = note({ tag: "task-1", url: "/tasks/1" });
    const b = note({ tag: "chat-t1", url: "/bots/b1/t1" });
    const closed = await closeNotifications({
      getNotifications: async () => [a.notification, b.notification],
    });
    expect(closed).toBe(2);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
  });

  it("is a no-op without a worker or without getNotifications (older engines)", async () => {
    expect(await closeNotifications(null)).toBe(0);
    expect(await closeNotifications(undefined)).toBe(0);
    expect(await closeNotifications({})).toBe(0);
    expect(
      await closeNotifications({
        getNotifications: async () => {
          throw new Error("not allowed");
        },
      }),
    ).toBe(0);
  });

  it("keeps closing the rest when one refuses", async () => {
    const bad = note({ url: "/bots", closeThrows: true });
    const good = note({ url: "/bots/b1/t1" });
    const closed = await closeNotifications({
      getNotifications: async () => [bad.notification, good.notification],
    });
    expect(closed).toBe(1);
    expect(good.close).toHaveBeenCalledOnce();
  });

  it("closes only the opened chat's notifications", async () => {
    const mine = note({ url: "/bots/b1/t1" });
    const byTag = note({ tag: "chat-t1", url: "/tasks/9" });
    const other = note({ tag: "chat-t2", url: "/bots/b1/t2" });
    const group = note({ tag: "group-g1", url: "/bots/groups/g1" });
    const closed = await closeNotifications(
      {
        getNotifications: async () => [
          mine.notification,
          byTag.notification,
          other.notification,
          group.notification,
        ],
      },
      (notification) => isChatNotification(notification, "b1", "t1"),
    );
    expect(closed).toBe(2);
    expect(other.close).not.toHaveBeenCalled();
    expect(group.close).not.toHaveBeenCalled();
  });

  it("matches a chat link however it was encoded, with or without a query", () => {
    const encoded = note({ url: "/bots/bot%20one/thread%3A1?from=push" }).notification;
    expect(isChatNotification(encoded, "bot one", "thread:1")).toBe(true);
    const trailing = note({ url: "/bots/b1/t1/" }).notification;
    expect(isChatNotification(trailing, "b1", "t1")).toBe(true);
    const prefix = note({ url: "/bots/b1/t10" }).notification;
    expect(isChatNotification(prefix, "b1", "t1")).toBe(false);
  });

  it("reads the deep link the worker stored, and nothing else", () => {
    expect(notificationUrl(note({ url: "/bots" }).notification)).toBe("/bots");
    expect(notificationUrl({ data: { url: 5 }, close: () => undefined })).toBeNull();
    expect(notificationUrl({ data: "x", close: () => undefined })).toBeNull();
  });
});

/**
 * A model of iOS on a backgrounded app: the tap brings the app to the front
 * (visibilitychange, then focus twice) and only then dispatches
 * notificationclick to the worker, for a notification that must still exist.
 * A notification the page closed in between takes its click with it.
 */
function iosTap(options: { clickAfterMs: number }) {
  const navigate = vi.fn();
  const reports: Record<string, unknown>[] = [];
  const shown: Array<ClosableNotification & { closed: boolean }> = [];
  const show = (url: string) => {
    const notification = {
      tag: `chat-${url.split("/").pop()}`,
      data: { url },
      closed: false,
      close: () => {
        notification.closed = true;
      },
    };
    shown.push(notification);
    return notification;
  };
  const registration = {
    getNotifications: async () => shown.filter((notification) => !notification.closed),
  };
  let visible = false;
  const taps = createNotificationTapController({
    navigate,
    currentPath: () => "/bots",
    takePending: async () => null,
    isVisible: () => visible,
    visibility: () => (visible ? "visible" : "hidden"),
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    ack: () => undefined,
    report: (record) => reports.push(record),
    onTap: () => deferred.noteTap(),
  });
  const deferred = createDeferredNotificationClear({
    close: () => closeNotifications(registration),
    isVisible: () => visible,
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    report: (record) => reports.push(record),
  });
  const tap = (
    notification: ReturnType<typeof show>,
    onResume: (reason: StaleClearReason) => void,
  ) => {
    visible = true;
    onResume("visible");
    onResume("focus");
    onResume("focus");
    setTimeout(() => {
      // WebKit: a closed notification has no click to dispatch.
      if (notification.closed) return;
      notification.closed = true;
      taps.onMessage(
        { type: "bots:navigate", url: notificationUrl(notification), id: "t1" },
        "broadcast",
      );
    }, options.clickAfterMs);
  };
  return {
    navigate,
    reports,
    show,
    tap,
    deferred,
    wake: () => {
      visible = true;
    },
    hide: () => {
      visible = false;
    },
    registration,
  };
}

describe("stale notifications vs a tap in flight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closing on resume, as 1.36.1 did, loses the tap (24 Sep, closed:1)", async () => {
    const ios = iosTap({ clickAfterMs: 20 });
    const reply = ios.show("/bots/b1/t1");
    ios.tap(reply, () => void closeNotifications(ios.registration));
    await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS * 2);
    expect(ios.navigate).not.toHaveBeenCalled();
  });

  it("delivers the tap when the clear waits, then clears the rest once", async () => {
    const ios = iosTap({ clickAfterMs: 900 });
    const older = ios.show("/tasks/9");
    const reply = ios.show("/bots/b1/t1");
    ios.tap(reply, (reason) => ios.deferred.schedule(reason));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ios.navigate).toHaveBeenCalledWith("/bots/b1/t1");
    expect(older.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS);
    expect(older.closed).toBe(true);
    const cleared = ios.reports.filter((record) => record.event === "notifications-cleared");
    expect(cleared).toEqual([
      expect.objectContaining({ reason: "visible", closed: 1, afterTap: true }),
    ]);
  });

  it("still delivers a slow tap that lands seconds after the resume", async () => {
    const ios = iosTap({ clickAfterMs: CLEAR_STALE_NOTIFICATIONS_DELAY_MS - 500 });
    const reply = ios.show("/bots/b1/t1");
    ios.tap(reply, (reason) => ios.deferred.schedule(reason));
    await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS * 2);
    expect(ios.navigate).toHaveBeenCalledWith("/bots/b1/t1");
  });

  it("clears a stale one when the app was opened without a tap", async () => {
    const ios = iosTap({ clickAfterMs: 0 });
    const stale = ios.show("/bots/b1/t1");
    ios.wake();
    ios.deferred.schedule("visible");
    await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS - 1);
    expect(stale.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stale.closed).toBe(true);
    expect(ios.reports).toEqual([
      expect.objectContaining({
        event: "notifications-cleared",
        reason: "visible",
        closed: 1,
        afterTap: false,
        waitedMs: CLEAR_STALE_NOTIFICATIONS_DELAY_MS,
      }),
    ]);
  });

  it("skips the clear, and says so, when the app goes back to the background first", async () => {
    const ios = iosTap({ clickAfterMs: 0 });
    const stale = ios.show("/bots/b1/t1");
    ios.wake();
    ios.deferred.schedule("focus");
    await vi.advanceTimersByTimeAsync(2_000);
    ios.hide();
    ios.deferred.cancel();
    await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS);
    expect(stale.closed).toBe(false);
    expect(ios.reports).toEqual([
      expect.objectContaining({ event: "notifications-clear-skipped", reason: "focus" }),
    ]);
  });
});
