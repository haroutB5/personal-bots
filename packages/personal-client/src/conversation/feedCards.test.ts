import { describe, expect, it } from "vite-plus/test";

import { buildConversationItems, type ConversationItem } from "./conversationModel.ts";
import type { TimelineEntry } from "./types.ts";
import { placeChatCards, type ChatCardSources } from "./feedCards.ts";

const message = (id: string, createdAt: string) =>
  ({
    id,
    kind: "message",
    createdAt,
    message: { id, role: "assistant", text: id, createdAt, updatedAt: createdAt, streaming: false },
  }) as unknown as TimelineEntry;

const baseSources = (overrides: Partial<ChatCardSources> = {}): ChatCardSources => ({
  questions: [],
  secrets: [],
  logins: [],
  connectionApprovals: [],
  leadBotChanges: [],
  memoryChanges: [],
  ...overrides,
});

const lead = (changeId: string, at: string) =>
  ({
    kind: "declined",
    changeId,
    createdAtMs: Date.parse(at),
    change: { changeId, changeHash: "hash", action: "remove", targetName: "Tax" },
  }) as never;

const memory = (changeId: number, at: string, pending: boolean) =>
  ({
    changeId,
    createdAtMs: Date.parse(at),
    pending,
    card: { changeId, threadId: "t1", content: "rule", targets: [] },
  }) as never;

const question = (requestId: string, at: string) =>
  ({
    kind: "answered",
    requestId,
    createdAt: at,
    questions: [],
    answers: {},
  }) as never;

describe("placeChatCards", () => {
  it("keeps a settled card where it happened and an open one last", () => {
    const items = buildConversationItems([
      message("u1", "2026-09-13T20:38:00.000Z"),
      message("a1", "2026-09-13T20:38:04.000Z"),
    ]) as ConversationItem[];
    const placed = placeChatCards(
      items,
      baseSources({
        questions: [question("q1", "2026-09-13T20:38:02.000Z")],
        leadBotChanges: [lead("l1", "2026-09-13T20:38:01.000Z")],
        memoryChanges: [memory(1, "2026-09-13T20:38:06.000Z", true)],
      }),
    );
    expect(placed.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "lead-bot-change",
      "question",
      "message",
      "memory-change",
    ]);
    expect(placed.at(-1)?.id).toBe("memory-change:1");
  });

  it("is a no-op when no card source has anything", () => {
    const items = buildConversationItems([
      message("u1", "2026-09-13T20:38:00.000Z"),
      message("a1", "2026-09-13T20:38:04.000Z"),
    ]) as ConversationItem[];
    expect(placeChatCards(items, baseSources())).toEqual(items);
  });
});
