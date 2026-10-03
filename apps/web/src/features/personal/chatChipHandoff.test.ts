import { describe, expect, it } from "vite-plus/test";

import {
  chipsShownFor,
  consumeChatSwitched,
  markChatSwitched,
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
