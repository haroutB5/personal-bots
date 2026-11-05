import type { PersonalMemoryTurnContext } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ConversationItem } from "../conversation/conversationModel.ts";
import {
  appChipLabel,
  contextUsedSummary,
  feedbackLabel,
  hasRecordedContext,
  nextFeedback,
  rulesHeadline,
  turnStartByAssistantItem,
  viaLabel,
} from "./contextUsed.ts";

const context = (overrides: Partial<PersonalMemoryTurnContext> = {}): PersonalMemoryTurnContext =>
  ({
    messageId: "m1",
    createdAt: "2026-10-04T20:00:00.000Z",
    apps: [{ slug: "matchday", label: "Matchday", via: ["title", "recent"] }],
    rules: {
      sent: true,
      items: [
        { memoryId: "r1", content: "Always answer in plain words.", apps: null, current: true },
        {
          memoryId: "r2",
          content: "Matchday dots show the name only.",
          apps: ["matchday"],
          current: true,
        },
      ],
      added: [],
      index: "hbots: 6 rules, CalTrack: 1 rule",
      leftOut: [],
    },
    notes: [
      {
        memoryId: "n1",
        kind: "note",
        snippet: "Matchday dots were redesigned on 2026-10-01.",
        why: ["names an app this chat is about"],
        score: 4.2,
        feedback: null,
        current: true,
      },
    ],
    leftOut: [
      {
        memoryId: "n3",
        kind: "note",
        snippet: "Garmin band works with the Venu3.",
        reason: "matched less than the best entries",
      },
    ],
    query: { terms: ["matchday", "dots"], followUp: true },
    ...overrides,
  }) as unknown as PersonalMemoryTurnContext;

describe("context used helpers", () => {
  it("says where an app was found and sums the turn up", () => {
    expect(viaLabel("title")).toBe("chat title");
    expect(viaLabel("earlier")).toBe("earlier in this chat");
    expect(appChipLabel({ slug: "matchday", label: "Matchday", via: ["title", "recent"] })).toBe(
      "Matchday · chat title, recent messages",
    );
    expect(contextUsedSummary(context())).toBe("2 rules · 1 note or summary · 1 left out");
    expect(
      contextUsedSummary(
        context({
          rules: {
            sent: false,
            items: [],
            added: [],
            index: null,
            leftOut: [{ memoryId: "x", content: "r", apps: ["matchday"], current: true }],
          },
          notes: [],
          leftOut: [],
        } as never),
      ),
    ).toBe("0 rules · 0 notes and summaries · 1 left out");
  });

  it("tells how the rules reached the bot", () => {
    expect(rulesHeadline(context().rules)).toBe("2 rules listed with this turn.");
    expect(rulesHeadline({ ...context().rules, sent: false })).toBe(
      "The 2 rules listed earlier in this chat still applied.",
    );
    expect(rulesHeadline({ ...context().rules, items: [] })).toBe("No rules applied.");
  });

  it("shows the line only for replies recent enough to have a recorded turn", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    expect(hasRecordedContext(new Date("2026-10-19T12:00:00.000Z"), now)).toBe(true);
    expect(hasRecordedContext(new Date("2026-10-07T12:00:00.000Z"), now)).toBe(true);
    expect(hasRecordedContext(new Date("2026-10-05T12:00:00.000Z"), now)).toBe(false);
  });

  it("pressing a mark sets it, pressing it again takes it back, the other one switches", () => {
    expect(nextFeedback(null, "outdated")).toBe("outdated");
    expect(nextFeedback("outdated", "outdated")).toBe("clear");
    expect(nextFeedback("outdated", "not_relevant")).toBe("not_relevant");
    expect(feedbackLabel("not_relevant")).toBe("Marked not relevant");
  });

  it("gives the view to the last reply of each turn only, naming the message that started it", () => {
    const msg = (id: string, role: "user" | "assistant") =>
      ({ kind: "message", id: `item-${id}`, message: { id, role } }) as unknown as ConversationItem;
    const items: Array<ConversationItem> = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      { kind: "work", id: "w1", entries: [] } as unknown as ConversationItem,
      msg("a2", "assistant"),
      msg("u2", "user"),
      msg("a3", "assistant"),
      {
        kind: "system-turn",
        id: "item-t1",
        message: { id: "personal-task-1" },
      } as unknown as ConversationItem,
      msg("a4", "assistant"),
      {
        kind: "notice",
        id: "n",
        message: { id: "personal-chat-notice" },
      } as unknown as ConversationItem,
    ];
    expect(Object.fromEntries(turnStartByAssistantItem(items))).toEqual({
      "item-a2": "u1",
      "item-a3": "u2",
      "item-a4": "personal-task-1",
    });
    expect(turnStartByAssistantItem([msg("a0", "assistant")]).size).toBe(0);
  });
});
