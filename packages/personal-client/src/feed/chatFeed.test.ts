import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";

import { buildChatFeed, workEntriesFromActivities } from "./chatFeed.ts";

function message(id: string, role: "user" | "assistant", text: string, createdAt: string) {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: TurnId.make("turn-1"),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("buildChatFeed", () => {
  it("puts messages and plans in time order with a divider", () => {
    const items = buildChatFeed({
      messages: [
        message("m1", "user", "hello", "2026-11-04T09:00:00.000Z"),
        message("m2", "assistant", "hi", "2026-11-04T09:00:01.000Z"),
      ],
      proposedPlans: [],
      activities: [],
    });
    expect(items.map((item) => item.kind)).toEqual(["divider", "message", "message"]);
    expect(items[1]?.kind === "message" ? items[1].message.text : null).toBe("hello");
  });

  it("hides work steps unless the setting is on", () => {
    const activities = [
      {
        id: "a1",
        tone: "tool" as const,
        kind: "tool.completed",
        summary: "Ran the tests",
        payload: {},
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-11-04T09:00:02.000Z",
      },
    ];
    const hidden = buildChatFeed({
      messages: [],
      proposedPlans: [],
      activities: activities as never,
    });
    const shown = buildChatFeed({
      messages: [],
      proposedPlans: [],
      activities: activities as never,
      showToolSteps: true,
    });
    expect(hidden.some((item) => item.kind === "work")).toBe(false);
    expect(shown.some((item) => item.kind === "work")).toBe(true);
  });

  it("keeps tool progress and checkpoints out of the work rows", () => {
    const entries = workEntriesFromActivities([
      {
        id: "a1",
        tone: "info",
        kind: "tool.progress",
        summary: "half way",
        payload: {},
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-11-04T09:00:00.000Z",
      },
      {
        id: "a2",
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {},
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-11-04T09:00:01.000Z",
      },
      {
        id: "a3",
        tone: "tool",
        kind: "tool.completed",
        summary: "Ran the tests",
        payload: {},
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-11-04T09:00:02.000Z",
      },
    ] as never);
    expect(entries.map((entry) => entry.label)).toEqual(["Ran the tests"]);
  });
});
