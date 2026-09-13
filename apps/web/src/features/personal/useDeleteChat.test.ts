import { describe, expect, it } from "vite-plus/test";

import { deleteChatConfirmMessage } from "./useDeleteChat";

describe("deleteChatConfirmMessage", () => {
  it("states the deletion is permanent and cannot be undone", () => {
    const message = deleteChatConfirmMessage();
    expect(message).toContain("permanently");
    expect(message).toContain("can't be undone");
  });
});
