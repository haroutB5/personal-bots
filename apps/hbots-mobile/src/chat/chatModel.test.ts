import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

const at = (iso: string) => DateTime.fromDateUnsafe(new Date(iso));

import { buildChatChips, chatSendModelSelection, latestUsedTokens } from "./chatModel";

describe("buildChatChips", () => {
  it("puts pinned chats first and then newest activity, current chip included", () => {
    const chips = buildChatChips({
      botId: "bot-1",
      currentThreadId: "thread-current",
      links: [
        {
          botId: "bot-1",
          threadId: "thread-old",
          createdAt: at("2026-11-01T09:00:00.000Z"),
          archivedAt: null,
          lastActivityAt: at("2026-11-01T10:00:00.000Z"),
        },
        {
          botId: "bot-1",
          threadId: "thread-pinned",
          createdAt: at("2026-11-01T09:00:00.000Z"),
          archivedAt: null,
          lastActivityAt: at("2026-11-01T09:30:00.000Z"),
          pinnedAt: at("2026-11-02T09:00:00.000Z"),
        },
        {
          botId: "bot-1",
          threadId: "thread-current",
          createdAt: at("2026-11-01T09:00:00.000Z"),
          archivedAt: null,
          lastActivityAt: at("2026-11-03T09:00:00.000Z"),
        },
      ] as never,
      shells: [
        { id: "thread-old", title: "Old chat" },
        { id: "thread-pinned", title: "Pinned chat" },
        { id: "thread-current", title: "Current chat" },
      ] as never,
    });
    expect(chips.map((chip) => chip.threadId)).toEqual([
      "thread-pinned",
      "thread-current",
      "thread-old",
    ]);
    expect(chips.find((chip) => chip.current)?.text).toBe("Current chat");
    expect(chips.find((chip) => chip.threadId === "thread-pinned")?.pinned).toBe(true);
  });
});

describe("chatSendModelSelection", () => {
  it("uses the bot's own model when there is one", () => {
    const bot = {
      modelSelection: { instanceId: "claudeAgent" as never, model: "claude-opus-5-5" },
    };
    expect(
      chatSendModelSelection(bot as never, {
        instanceId: "deepseek" as never,
        model: "deepseek-v4.1",
      }).instanceId,
    ).toBe("claudeAgent");
    expect(
      chatSendModelSelection(null, { instanceId: "deepseek" as never, model: "deepseek-v4.1" })
        .instanceId,
    ).toBe("deepseek");
  });
});

describe("latestUsedTokens", () => {
  it("reads the newest context-window activity", () => {
    expect(
      latestUsedTokens([
        { kind: "context-window.updated", payload: { usedTokens: 10 } },
        { kind: "tool.completed", payload: {} },
        { kind: "context-window.updated", payload: { usedTokens: 42 } },
      ]),
    ).toBe(42);
  });
});
