import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isChatsListLoad,
  markMessageSent,
  observeChatMessages,
  reportChatUsable,
  resetPerfRumForTest,
} from "./perfRum";

let now = 0;
let beacons: Array<Record<string, unknown>> = [];

beforeEach(() => {
  now = 1_000;
  beacons = [];
  resetPerfRumForTest(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: (at: number) => void) => {
    callback(now + 16);
    return 1;
  });
  vi.stubGlobal("location", { hostname: "prod-x.t3coderelay.com" });
  vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("performance", {
    now: () => now,
    getEntriesByType: () => [{ name: "https://prod-x.t3coderelay.com/bots" }],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      beacons.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const msg = (id: string, role: string, text = "") => ({ id, role, text });

describe("real-user timings", () => {
  it("times send -> server echo -> first reply text, once each", () => {
    const before = [msg("m1", "user", "hi"), msg("m2", "assistant", "hello")];
    markMessageSent("t1", before);
    now = 1_300;
    observeChatMessages("t1", [...before, msg("m3", "user", "next")]);
    now = 3_000;
    observeChatMessages("t1", [...before, msg("m3", "user", "next"), msg("m4", "assistant", "")]);
    now = 3_400;
    observeChatMessages("t1", [
      ...before,
      msg("m3", "user", "next"),
      msg("m4", "assistant", "Sure"),
    ]);
    // Later deltas of the same reply report nothing more.
    now = 3_600;
    observeChatMessages("t1", [
      ...before,
      msg("m3", "user", "next"),
      msg("m4", "assistant", "Sure, here"),
    ]);
    expect(beacons.map((b) => [b.journey, b.ms, b.warm, b.via])).toEqual([
      ["j3-echo", 316, true, "relay"],
      ["j3-first", 2_416, true, "relay"],
    ]);
  });

  it("ignores other chats' messages", () => {
    markMessageSent("t1", []);
    observeChatMessages("t2", [msg("x", "assistant", "other chat")]);
    expect(beacons).toEqual([]);
  });

  it("times a tap on a chat row until the chat is usable", () => {
    // A pointerdown on the row link is what the capture listener records.
    const listeners: Record<string, (event: unknown) => void> = {};
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        listeners[name] = listener;
      },
    });
    resetPerfRumForTest(() => now);
    return import("./perfRum").then(({ installPerfRum }) => {
      installPerfRum();
      const link = { getAttribute: () => "/bots/b1/t1" };
      listeners.pointerdown!({ target: { closest: () => link } });
      now = 1_650;
      reportChatUsable("/bots/b1/t1");
      expect(beacons.map((b) => [b.journey, b.ms])).toEqual([["j2", 666]]);
    });
  });

  it("knows a load on the chats list from a load on anything else", () => {
    expect(isChatsListLoad("/bots")).toBe(true);
    expect(isChatsListLoad("/bots/")).toBe(true);
    expect(isChatsListLoad("/bots/b1/t1")).toBe(false);
    expect(isChatsListLoad(null)).toBe(false);
  });
});
