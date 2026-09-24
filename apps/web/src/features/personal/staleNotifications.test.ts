import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ClosableNotification,
  closeNotifications,
  isChatNotification,
  notificationUrl,
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
