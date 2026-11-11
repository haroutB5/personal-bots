import { describe, expect, it, vi } from "vitest";

import { clearChatNotifications } from "./clearChatNotifications";

describe("clearChatNotifications", () => {
  it("asks the phone to drop the notifications of the opened chat", () => {
    const cancelForChat = vi.fn();
    expect(clearChatNotifications("t1", { cancelForChat })).toBe(true);
    expect(cancelForChat).toHaveBeenCalledWith("t1");
  });

  it("does nothing for a chat with no thread yet", () => {
    const cancelForChat = vi.fn();
    expect(clearChatNotifications("", { cancelForChat })).toBe(false);
    expect(cancelForChat).not.toHaveBeenCalled();
  });

  it("copes with a build that has no native module", () => {
    expect(clearChatNotifications("t1", null)).toBe(false);
  });
});
