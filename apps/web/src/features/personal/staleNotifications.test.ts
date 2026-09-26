import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createNotificationTapController } from "./notificationTap";
import {
  CLEAR_STALE_NOTIFICATIONS_DELAY_MS,
  type ClosableNotification,
  closeNotifications,
  isChatNotification,
  isGroupNotification,
  isTaskNotification,
  notificationUrl,
  useCloseChatNotifications,
  useCloseGroupNotifications,
  useCloseTaskNotifications,
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

const everything = () => true;

describe("stale notifications", () => {
  it("closes only what the match accepts, and counts them", async () => {
    const a = note({ tag: "task-1", url: "/tasks/1" });
    const b = note({ tag: "chat-t1", url: "/bots/b1/t1" });
    const closed = await closeNotifications(
      { getNotifications: async () => [a.notification, b.notification] },
      (notification) => notification.tag === "chat-t1",
    );
    expect(closed).toBe(1);
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).toHaveBeenCalledOnce();
  });

  it("is a no-op without a worker or without getNotifications (older engines)", async () => {
    expect(await closeNotifications(null, everything)).toBe(0);
    expect(await closeNotifications(undefined, everything)).toBe(0);
    expect(await closeNotifications({}, everything)).toBe(0);
    expect(
      await closeNotifications(
        {
          getNotifications: async () => {
            throw new Error("not allowed");
          },
        },
        everything,
      ),
    ).toBe(0);
  });

  it("keeps closing the rest when one refuses", async () => {
    const bad = note({ url: "/bots", closeThrows: true });
    const good = note({ url: "/bots/b1/t1" });
    const closed = await closeNotifications(
      { getNotifications: async () => [bad.notification, good.notification] },
      everything,
    );
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

  it("matches a group chat and a task by tag or by link, and nothing else", () => {
    expect(isGroupNotification(note({ tag: "group-g1" }).notification, "g1")).toBe(true);
    expect(isGroupNotification(note({ url: "/bots/groups/g1" }).notification, "g1")).toBe(true);
    expect(
      isGroupNotification(note({ tag: "group-g2", url: "/bots/groups/g2" }).notification, "g1"),
    ).toBe(false);
    expect(
      isGroupNotification(note({ tag: "chat-g1", url: "/bots/b1/g1" }).notification, "g1"),
    ).toBe(false);
    expect(isTaskNotification(note({ tag: "task-t9" }).notification, "t9")).toBe(true);
    expect(isTaskNotification(note({ url: "/tasks/t9" }).notification, "t9")).toBe(true);
    expect(
      isTaskNotification(note({ tag: "task-t10", url: "/tasks/t10" }).notification, "t9"),
    ).toBe(false);
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
  });
  const tap = (notification: ReturnType<typeof show>, onResume: () => void) => {
    visible = true;
    onResume();
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
  return { navigate, show, tap, registration };
}

describe("coming back to the app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closing everything on resume, as 1.36.1 did, loses the tap (24 Sep, closed:1)", async () => {
    const ios = iosTap({ clickAfterMs: 20 });
    const reply = ios.show("/bots/b1/t1");
    ios.tap(reply, () => void closeNotifications(ios.registration, everything));
    await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS * 2);
    expect(ios.navigate).not.toHaveBeenCalled();
  });

  it("delivers the tap and leaves the older, untapped notifications alone", async () => {
    const ios = iosTap({ clickAfterMs: 900 });
    const olderTask = ios.show("/tasks/9");
    const olderChat = ios.show("/bots/b2/t2");
    const reply = ios.show("/bots/b1/t1");
    // Resuming the app closes nothing (serviceWorker.ts).
    ios.tap(reply, () => undefined);
    await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS * 4);
    expect(ios.navigate).toHaveBeenCalledWith("/bots/b1/t1");
    expect(olderTask.closed).toBe(false);
    expect(olderChat.closed).toBe(false);
  });
});

describe("an open chat's notifications", () => {
  let renderer: ReactTestRenderer | undefined;
  let visibility: "visible" | "hidden" = "visible";
  let listeners: Array<() => void> = [];
  let notifications: Array<ReturnType<typeof note>> = [];

  const Chat = ({ botId, threadId }: { botId: string; threadId: string }) => {
    useCloseChatNotifications(botId, threadId);
    return null;
  };
  const Group = ({ groupId }: { groupId: string }) => {
    useCloseGroupNotifications(groupId);
    return null;
  };
  const Task = ({ taskId }: { taskId: string }) => {
    useCloseTaskNotifications(taskId);
    return null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    visibility = "visible";
    listeners = [];
    notifications = [];
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") listeners.push(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") listeners = listeners.filter((item) => item !== listener);
      },
    });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => ({
          getNotifications: async () =>
            notifications
              .filter((item) => item.close.mock.calls.length === 0)
              .map((item) => item.notification),
        }),
      },
    });
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const setVisibility = (next: "visible" | "hidden") => {
    visibility = next;
    for (const listener of listeners) listener();
  };

  it("closes this chat's notifications when it opens, and no other", async () => {
    const mine = note({ tag: "chat-t1", url: "/bots/b1/t1" });
    const otherChat = note({ tag: "chat-t2", url: "/bots/b1/t2" });
    const task = note({ tag: "task-9", url: "/tasks/9" });
    notifications = [mine, otherChat, task];
    await act(async () => {
      renderer = create(createElement(Chat, { botId: "b1", threadId: "t1" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mine.close).toHaveBeenCalledOnce();
    expect(otherChat.close).not.toHaveBeenCalled();
    expect(task.close).not.toHaveBeenCalled();
  });

  it("waits after a resume before closing, so a tap on it still lands", async () => {
    await act(async () => {
      renderer = create(createElement(Chat, { botId: "b1", threadId: "t1" }));
    });
    setVisibility("hidden");
    const arrived = note({ tag: "chat-t1", url: "/bots/b1/t1" });
    const elsewhere = note({ tag: "chat-t3", url: "/bots/b2/t3" });
    notifications = [arrived, elsewhere];
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLEAR_STALE_NOTIFICATIONS_DELAY_MS - 1);
    });
    expect(arrived.close).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(arrived.close).toHaveBeenCalledOnce();
    expect(elsewhere.close).not.toHaveBeenCalled();
  });

  it("an open group chat or task closes its own notifications, and no other", async () => {
    const group = note({ tag: "group-g1", url: "/bots/groups/g1" });
    const task = note({ tag: "task-t9", url: "/tasks/t9" });
    const chat = note({ tag: "chat-t1", url: "/bots/b1/t1" });
    notifications = [group, task, chat];
    await act(async () => {
      renderer = create(createElement(Group, { groupId: "g1" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(group.close).toHaveBeenCalledOnce();
    expect(task.close).not.toHaveBeenCalled();
    expect(chat.close).not.toHaveBeenCalled();
    await act(async () => renderer?.update(createElement(Task, { taskId: "t9" })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(task.close).toHaveBeenCalledOnce();
    expect(chat.close).not.toHaveBeenCalled();
  });
});
