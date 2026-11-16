import { describe, expect, it } from "vite-plus/test";

import { TAP_MAX_AGE_MS, noteChatTap, takeChatTap } from "./chatOpenIntent";

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
