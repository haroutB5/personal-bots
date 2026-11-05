import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";
import { describe, expect, it } from "vite-plus/test";

import { lastTurnStartMessageId } from "./contextTurn";

const message = (id: string, role: "user" | "assistant"): ConversationItem =>
  ({
    kind: "message",
    id,
    message: { id, role, text: id, createdAt: "2026-11-05T10:00:00.000Z" },
  }) as never;

describe("lastTurnStartMessageId", () => {
  it("names the user message that started the last reply", () => {
    const items = [
      message("u1", "user"),
      message("a1", "assistant"),
      message("u2", "user"),
      message("a2", "assistant"),
    ];
    expect(lastTurnStartMessageId(items)).toBe("u2");
  });

  it("is null before the bot has replied", () => {
    expect(lastTurnStartMessageId([message("u1", "user")])).toBeNull();
    expect(lastTurnStartMessageId([])).toBeNull();
  });
});
