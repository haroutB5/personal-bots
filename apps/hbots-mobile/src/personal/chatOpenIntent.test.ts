import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetPerfOffForTest, setPerfOff } from "../perfFlags";
import {
  HELD_MEMORY_TTL_MS,
  TAP_MAX_AGE_MS,
  chatInMemory,
  holdChat,
  noteChatTap,
  startChatOpen,
  takeChatTap,
} from "./chatOpenIntent";

afterEach(() => {
  resetPerfOffForTest();
  vi.restoreAllMocks();
});

describe("the tap that opens a chat", () => {
  it("hands the tap time to the screen that mounts for that chat, once", () => {
    noteChatTap("t-a", 1_000);

    expect(takeChatTap("t-a", 1_210)).toBe(1_000);
    expect(takeChatTap("t-a", 1_220)).toBeUndefined();
  });

  it("keys the tap by chat, so a tap on another row is not borrowed", () => {
    noteChatTap("t-a", 1_000);
    noteChatTap("t-b", 1_050);

    expect(takeChatTap("t-b", 1_300)).toBe(1_050);
    expect(takeChatTap("t-a", 1_300)).toBe(1_000);
  });

  it("drops a tap older than the window, so a later open from a link is not timed from it", () => {
    noteChatTap("t-old", 1_000);

    expect(takeChatTap("t-old", 1_000 + TAP_MAX_AGE_MS + 1)).toBeUndefined();
  });

  it("never hands out a tap from after the mount", () => {
    noteChatTap("t-late", 2_000);

    expect(takeChatTap("t-late", 1_990)).toBe(1_990);
  });

  it("keeps the newest tap when a row is tapped twice", () => {
    noteChatTap("t-twice", 3_000);
    noteChatTap("t-twice", 3_400);

    expect(takeChatTap("t-twice", 3_600)).toBe(3_400);
  });
});

describe("starting a chat open at the press", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(50_000);
  });

  const deps = (savedCopy = false) => ({
    hasSavedCopy: vi.fn(() => savedCopy),
    prefetch: vi.fn(),
  });

  it("prefetches a chat that is neither in memory nor saved on the phone, and notes the tap", () => {
    const wired = deps();

    expect(startChatOpen("t-net", wired)).toBe("prefetched");

    expect(wired.prefetch).toHaveBeenCalledExactlyOnceWith("t-net");
    expect(takeChatTap("t-net", 50_000)).toBe(50_000);
  });

  it("does not prefetch a chat that is in memory, and still notes the tap", () => {
    const wired = deps();
    const release = holdChat("t-mem");

    expect(startChatOpen("t-mem", wired)).toBe("in-memory");
    release();

    expect(wired.prefetch).not.toHaveBeenCalled();
    expect(takeChatTap("t-mem", 50_000)).toBe(50_000);
  });

  it("does not prefetch a chat the phone has a saved copy of: that open never asks the server", () => {
    const wired = deps(true);

    expect(startChatOpen("t-saved", wired)).toBe("saved-copy");

    expect(wired.prefetch).not.toHaveBeenCalled();
  });

  it("does not prefetch when android-preload-chat is in perfOff, and still notes the tap", () => {
    setPerfOff(["android-preload-chat"]);
    const wired = deps();

    expect(startChatOpen("t-off", wired)).toBe("switched-off");

    expect(wired.prefetch).not.toHaveBeenCalled();
    expect(wired.hasSavedCopy).not.toHaveBeenCalled();
    expect(takeChatTap("t-off", 50_000)).toBe(50_000);
  });

  it("prefetches again once a different switch is the only one off", () => {
    setPerfOff(["android-other"]);
    const wired = deps();

    expect(startChatOpen("t-other", wired)).toBe("prefetched");
  });
});

describe("a chat held in memory", () => {
  it("is in memory while the screen holds it and for the retention window after it is released", () => {
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(1_000);
    const release = holdChat("t-held");
    clock.mockReturnValue(1_000 + 10 * HELD_MEMORY_TTL_MS);
    expect(chatInMemory("t-held")).toBe(true);

    release();
    expect(chatInMemory("t-held")).toBe(true);

    clock.mockReturnValue(1_000 + 10 * HELD_MEMORY_TTL_MS + HELD_MEMORY_TTL_MS - 1);
    expect(chatInMemory("t-held")).toBe(true);
    clock.mockReturnValue(1_000 + 10 * HELD_MEMORY_TTL_MS + HELD_MEMORY_TTL_MS + 1);
    expect(chatInMemory("t-held")).toBe(false);
  });

  it("is not in memory for a chat never held", () => {
    expect(chatInMemory("t-never")).toBe(false);
  });
});
