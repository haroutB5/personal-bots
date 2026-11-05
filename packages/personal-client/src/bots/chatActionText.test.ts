import { describe, expect, it } from "vite-plus/test";

import { chatActionFailure, deleteChatConfirmMessage, quotedChatName } from "./chatActionText.ts";

describe("chatActionText", () => {
  it("quotes a chat name", () => {
    expect(quotedChatName("Tennis")).toBe("“Tennis”");
  });

  it("names the chat in a failure, with the reason when there is one", () => {
    expect(chatActionFailure("delete", "Tennis")).toBe("Couldn't delete “Tennis”. Try again.");
    expect(chatActionFailure("archive", "Tennis", "It is busy.")).toBe(
      "Couldn't archive “Tennis”: It is busy.",
    );
  });

  it("asks about the open chat without a name", () => {
    expect(deleteChatConfirmMessage()).toBe(
      "Delete this chat permanently?\nThe whole conversation is removed and can't be undone.",
    );
  });

  it("names another chat and warns when it is working", () => {
    expect(deleteChatConfirmMessage({ title: "Tennis", working: true })).toBe(
      "Delete “Tennis” permanently?\nThe whole conversation is removed and can't be undone.\nIt is working right now; deleting it stops that too.",
    );
  });
});
