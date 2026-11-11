import { describe, expect, it } from "vite-plus/test";

import { pushRowText, type PushStatus } from "../notifications/pushState";
import { canSendTest, channelRows, importanceText } from "./notificationsScreenModel";

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
