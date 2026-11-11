import { describe, expect, it, vi } from "vite-plus/test";

import { pushRowText, type PushStatus } from "../notifications/pushState";
import {
  askForNotifications,
  canSendTest,
  channelRows,
  importanceText,
  permissionRow,
} from "./notificationsScreenModel";

const channel = (id: string, name: string, importance = 4) => ({
  id,
  name,
  importance,
  group: null,
});

describe("importanceText", () => {
  it("names each Android level in plain words", () => {
    expect(importanceText(0)).toBe("Off");
    expect(importanceText(2)).toBe("Silent");
    expect(importanceText(3)).toBe("Sound");
    expect(importanceText(4)).toBe("Sound and pop-up");
  });
});

describe("channelRows", () => {
  it("lists sign-in first, then bots by name, and hides channels it does not own", () => {
    const rows = channelRows([
      channel("bot.b2", "Zed"),
      channel("working", "Bots working", 2),
      channel("hbots-updates", "App updates", 3),
      channel("bot.b1", "Ada", 0),
      channel("account", "Sign-in and security"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["account", "bot.b1", "bot.b2"]);
    expect(rows[1]).toEqual({ id: "bot.b1", title: "Ada", detail: "Off" });
  });

  it("is empty before any channel exists", () => {
    expect(channelRows([])).toEqual([]);
  });
});

describe("push row for every state", () => {
  const states: ReadonlyArray<PushStatus> = [
    { kind: "checking" },
    { kind: "unconfigured" },
    { kind: "server-off" },
    { kind: "blocked" },
    { kind: "on", tokenRegisteredAt: 1 },
    { kind: "error", message: "No answer." },
  ];

  it("gives each state a title and a body without jargon", () => {
    for (const state of states) {
      const text = pushRowText(state);
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.body.length).toBeGreaterThan(0);
      expect(`${text.title} ${text.body}`).not.toMatch(/FCM|Firebase|token|DPoP/i);
    }
  });

  it("offers an action only where one helps", () => {
    expect(pushRowText({ kind: "blocked" }).action).toBe("turn-on");
    expect(pushRowText({ kind: "error", message: "x" }).action).toBe("retry");
    expect(pushRowText({ kind: "unconfigured" }).action).toBeNull();
    expect(pushRowText({ kind: "server-off" }).action).toBeNull();
  });

  it("allows a test push only when the phone is registered", () => {
    expect(states.filter(canSendTest).map((state) => state.kind)).toEqual(["on"]);
  });
});

describe("the notification permission row", () => {
  it("shows after a deny on a build that cannot register, with a way back", () => {
    const row = permissionRow({ enabled: false, push: "unconfigured" });
    expect(row?.title).toBe("Notifications are off");
    expect(row?.actionLabel).toBe("Turn on");
    expect(row?.settingsLabel).toBe("Open Android settings");
  });

  it("is absent when Android allows notifications", () => {
    expect(permissionRow({ enabled: true, push: "unconfigured" })).toBeNull();
    expect(permissionRow({ enabled: true, push: "on" })).toBeNull();
  });

  it("leaves a build that can register to its own push row", () => {
    expect(permissionRow({ enabled: false, push: "blocked" })).toBeNull();
  });
});

describe("asking again", () => {
  const port = (answer: "granted" | "denied" | "blocked" | "not-needed") => ({
    request: vi.fn(async () => answer),
    openSettings: vi.fn(),
  });

  it("asks Android first and leaves settings alone while Android still prompts", async () => {
    const p = port("denied");
    expect(await askForNotifications(p)).toBe("denied");
    expect(p.request).toHaveBeenCalledTimes(1);
    expect(p.openSettings).not.toHaveBeenCalled();
  });

  it("opens the app's notification settings when Android will not prompt again", async () => {
    const p = port("blocked");
    expect(await askForNotifications(p)).toBe("blocked");
    expect(p.openSettings).toHaveBeenCalledTimes(1);
  });

  it("opens settings on a phone that has no prompt", async () => {
    const p = port("not-needed");
    await askForNotifications(p);
    expect(p.openSettings).toHaveBeenCalledTimes(1);
  });

  it("does not open settings after a yes", async () => {
    const p = port("granted");
    await askForNotifications(p);
    expect(p.openSettings).not.toHaveBeenCalled();
  });
});
