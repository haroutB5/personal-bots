import type { PersonalPushInAppNotification } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planInAppNotifications } from "./inAppNotificationPlan";

const note = (id: string, url = `/bots/bot-1/${id}`): PersonalPushInAppNotification => ({
  id,
  title: "Assistant replied",
  body: "Open the chat to read it.",
  url,
});

describe("planInAppNotifications", () => {
  it("acknowledges and shows a new notification on a visible page", () => {
    const seen = new Set<string>();
    expect(
      planInAppNotifications(seen, [note("a")], { visible: true, currentPath: "/bots" }),
    ).toEqual({ ack: ["a"], show: note("a") });
    // The same feed again is nothing new.
    expect(
      planInAppNotifications(seen, [note("a")], { visible: true, currentPath: "/bots" }),
    ).toEqual({ ack: [], show: null });
  });

  it("acknowledges all new ones and shows only the newest", () => {
    const seen = new Set<string>(["a"]);
    expect(
      planInAppNotifications(seen, [note("a"), note("b"), note("c")], {
        visible: true,
        currentPath: "/tasks",
      }),
    ).toEqual({ ack: ["b", "c"], show: note("c") });
  });

  it("does not show a banner for the screen already open, but still takes it", () => {
    const seen = new Set<string>();
    expect(
      planInAppNotifications(seen, [note("a", "/bots/bot-1/a")], {
        visible: true,
        currentPath: "/bots/bot-1/a",
      }),
    ).toEqual({ ack: ["a"], show: null });
  });

  it("reading the chat a notification is about confirms it without a banner", () => {
    // A task finished in the chat on screen: its url is the task, its quiet
    // path the chat. The ack is what tells the server the user saw it.
    const seen = new Set<string>();
    expect(
      planInAppNotifications(
        seen,
        [{ ...note("a", "/tasks/task-1"), quietPath: "/bots/bot-1/thread-1" }],
        { visible: true, currentPath: "/bots/bot-1/thread-1" },
      ),
    ).toEqual({ ack: ["a"], show: null });
  });

  it("a hidden page takes nothing, so the server sends a push instead", () => {
    const seen = new Set<string>();
    expect(
      planInAppNotifications(seen, [note("a")], { visible: false, currentPath: "/bots" }),
    ).toEqual({ ack: [], show: null });
    // Coming back later does not replay it as a stale banner.
    expect(
      planInAppNotifications(seen, [note("a")], { visible: true, currentPath: "/bots" }),
    ).toEqual({ ack: [], show: null });
  });
});
