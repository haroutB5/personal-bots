import { describe, expect, it } from "vite-plus/test";

import {
  chipsShownFor,
  clearPendingWrapup,
  consumeChatSwitched,
  markChatSwitched,
  markPendingWrapup,
  pendingWrapupFor,
  pendingWrapupStep,
  rememberChipsShown,
} from "./chatChipHandoff";

describe("chat switch mark", () => {
  it("is spent by the first transcript that mounts", () => {
    markChatSwitched(1_000);
    expect(consumeChatSwitched(1_400)).toBe(true);
    expect(consumeChatSwitched(1_400)).toBe(false);
  });

  it("expires, so opening a chat later is never animated", () => {
    markChatSwitched(1_000);
    expect(consumeChatSwitched(1_000 + 3_001)).toBe(false);
  });

  it("is off when no chip was tapped", () => {
    expect(consumeChatSwitched()).toBe(false);
  });
});

describe("chips remembered per bot", () => {
  it("starts off and follows the header's last state for that bot", () => {
    expect(chipsShownFor("bot-never-seen")).toBe(false);
    rememberChipsShown("bot-a", true);
    rememberChipsShown("bot-b", false);
    expect(chipsShownFor("bot-a")).toBe(true);
    expect(chipsShownFor("bot-b")).toBe(false);
    rememberChipsShown("bot-a", false);
    expect(chipsShownFor("bot-a")).toBe(false);
  });
});

describe("a wrapup waiting for another chat", () => {
  it("is for that chat only, and lasts about ten seconds", () => {
    markPendingWrapup("t-2", 1_000);
    expect(pendingWrapupFor("t-2", 1_500)).toBe(true);
    expect(pendingWrapupFor("t-3", 1_500)).toBe(false);
    expect(pendingWrapupFor("t-2", 1_000 + 10_000)).toBe(true);
    expect(pendingWrapupFor("t-2", 1_000 + 10_001)).toBe(false);
  });

  it("is not spent by looking, only by clearing", () => {
    markPendingWrapup("t-2", 1_000);
    expect(pendingWrapupFor("t-2", 1_100)).toBe(true);
    expect(pendingWrapupFor("t-2", 1_200)).toBe(true);
    clearPendingWrapup();
    expect(pendingWrapupFor("t-2", 1_300)).toBe(false);
  });

  it("a newer mark replaces the older one", () => {
    markPendingWrapup("t-2", 1_000);
    markPendingWrapup("t-3", 1_000);
    expect(pendingWrapupFor("t-2", 1_100)).toBe(false);
    expect(pendingWrapupFor("t-3", 1_100)).toBe(true);
  });

  it("waits for the thread, then starts when the chat can take a turn, else fails", () => {
    expect(pendingWrapupStep({ pending: false, threadLoaded: true, canStart: true })).toBe("none");
    expect(pendingWrapupStep({ pending: true, threadLoaded: false, canStart: true })).toBe("wait");
    expect(pendingWrapupStep({ pending: true, threadLoaded: true, canStart: true })).toBe("start");
    expect(pendingWrapupStep({ pending: true, threadLoaded: true, canStart: false })).toBe("fail");
  });
});
