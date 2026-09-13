import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "~/session-logic";

import {
  buildConversationItems,
  deriveConversationState,
  formatDayDivider,
} from "./conversationModel";

const session = (status: OrchestrationSession["status"]) =>
  ({ status }) as unknown as OrchestrationSession;
const turn = (state: OrchestrationLatestTurn["state"]) =>
  ({ state }) as unknown as OrchestrationLatestTurn;

describe("deriveConversationState", () => {
  const none = { pendingApprovals: [], pendingUserInputs: [] };

  it("is idle without a session", () => {
    expect(deriveConversationState({ session: null, latestTurn: null, ...none })).toBe("idle");
  });

  it("is working while a turn or session runs", () => {
    expect(deriveConversationState({ session: null, latestTurn: turn("running"), ...none })).toBe(
      "working",
    );
    expect(
      deriveConversationState({ session: session("starting"), latestTurn: null, ...none }),
    ).toBe("working");
  });

  it("waits for the user over everything else", () => {
    expect(
      deriveConversationState({
        session: session("running"),
        latestTurn: turn("running"),
        pendingApprovals: [{ requestId: "r1" } as never],
        pendingUserInputs: [],
      }),
    ).toBe("waiting");
  });

  it("reports errors from the session or the last turn", () => {
    expect(deriveConversationState({ session: session("error"), latestTurn: null, ...none })).toBe(
      "error",
    );
    expect(
      deriveConversationState({ session: session("ready"), latestTurn: turn("error"), ...none }),
    ).toBe("error");
    expect(
      deriveConversationState({
        session: session("ready"),
        latestTurn: turn("completed"),
        ...none,
      }),
    ).toBe("idle");
  });
});

describe("formatDayDivider", () => {
  const now = new Date("2026-09-13T20:40:00.000Z"); // 21:40 BST

  it("uses Europe/London wall time", () => {
    expect(formatDayDivider(new Date("2026-09-13T20:38:00.000Z"), now)).toBe("Today, 21:38");
    expect(formatDayDivider(new Date("2026-09-12T08:05:00.000Z"), now)).toBe("Yesterday, 09:05");
    expect(formatDayDivider(new Date("2026-09-01T13:00:00.000Z"), now)).toBe("1 Sep, 14:00");
    expect(formatDayDivider(new Date("2025-12-24T13:00:00.000Z"), now)).toBe("24 Dec 2025, 13:00");
  });

  it("rolls the day at London midnight, not UTC midnight", () => {
    // 23:30 UTC on the 12th is 00:30 BST on the 13th.
    expect(formatDayDivider(new Date("2026-09-12T23:30:00.000Z"), now)).toBe("Today, 00:30");
  });
});

const message = (id: string, role: "user" | "assistant" | "system", createdAt: string) =>
  ({
    id,
    kind: "message",
    createdAt,
    message: { id, role, text: id, createdAt, streaming: false },
  }) as unknown as TimelineEntry;

const work = (id: string, createdAt: string) =>
  ({
    id,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label: id, tone: "tool" },
  }) as unknown as TimelineEntry;

describe("buildConversationItems", () => {
  it("folds consecutive work into one group and skips system messages", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-13T20:38:00.000Z"),
      message("s1", "system", "2026-09-13T20:38:01.000Z"),
      work("w1", "2026-09-13T20:38:02.000Z"),
      work("w2", "2026-09-13T20:38:03.000Z"),
      message("a1", "assistant", "2026-09-13T20:38:04.000Z"),
      work("w3", "2026-09-13T20:38:05.000Z"),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "work",
      "message",
      "work",
    ]);
    const firstWork = items[2];
    expect(firstWork?.kind === "work" ? firstWork.entries.map((entry) => entry.id) : []).toEqual([
      "w1",
      "w2",
    ]);
  });

  it("starts a divider on a new day or after an hour of silence", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-12T22:50:00.000Z"), // 23:50 BST on the 12th
      message("u2", "user", "2026-09-12T23:10:00.000Z"), // 00:10 BST on the 13th
      message("u3", "user", "2026-09-12T23:40:00.000Z"),
      message("u4", "user", "2026-09-13T01:00:00.000Z"),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "divider",
      "message",
      "message",
      "divider",
      "message",
    ]);
  });
});
