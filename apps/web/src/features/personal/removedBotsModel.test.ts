import * as DateTime from "effect/DateTime";
import type { PersonalBotRestoreResult, PersonalRemovedBot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chatsKeptLabel,
  mergeSeenRemovedBots,
  removedBotSubtitle,
  removedByLine,
  restoredMessage,
} from "./removedBotsModel";

const NOW = Date.parse("2026-09-13T20:40:00Z");

const removed = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    botId: "bot-1",
    name: "Analyst",
    title: "",
    team: "dev",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelLabel: "Sonnet 5.5 · H",
    removedAt: DateTime.makeUnsafe("2026-09-10T10:00:00.000Z"),
    removedBy: "CFO",
    reason: null,
    chats: 2,
    ...overrides,
  }) as unknown as PersonalRemovedBot;

describe("removedBotSubtitle", () => {
  it("joins the team label and the model label", () => {
    expect(removedBotSubtitle(removed())).toBe("Dev team · Sonnet 5.5 · H");
    expect(removedBotSubtitle(removed({ team: "Finance" }))).toBe("Finance · Sonnet 5.5 · H");
  });

  it("drops an empty model label", () => {
    expect(removedBotSubtitle(removed({ modelLabel: " " }))).toBe("Dev team");
  });
});

describe("removedByLine", () => {
  const line = (removedAt: string) =>
    removedByLine(removed({ removedAt: DateTime.makeUnsafe(removedAt) }), NOW);

  it("reads as a sentence for every step of the relative time", () => {
    expect(line("2026-09-13T20:39:30Z")).toBe("Removed by CFO today");
    expect(line("2026-09-13T15:00:00Z")).toBe("Removed by CFO today");
    expect(line("2026-09-12T12:00:00Z")).toBe("Removed by CFO yesterday");
    expect(line("2026-09-10T10:00:00Z")).toBe("Removed by CFO on 10 Sep");
    expect(line("2025-12-31T10:00:00Z")).toBe("Removed by CFO on 31 Dec 2025");
  });
});

describe("chatsKeptLabel", () => {
  it("pluralises", () => {
    expect(chatsKeptLabel(0)).toBe("0 chats kept");
    expect(chatsKeptLabel(1)).toBe("1 chat kept");
    expect(chatsKeptLabel(12)).toBe("12 chats kept");
  });
});

describe("restoredMessage", () => {
  const result = (name: string, renamedFrom: string | null) =>
    ({ bot: { name, team: "assistant" }, renamedFrom }) as unknown as PersonalBotRestoreResult;

  it("says where the bot went", () => {
    expect(restoredMessage(result("Analyst", null))).toBe("Analyst restored to Assistant's team");
  });

  it("says when the name was taken", () => {
    expect(restoredMessage(result("Analyst 2", "Analyst"))).toBe(
      "Restored as Analyst 2 (the name Analyst was taken)",
    );
  });
});

describe("mergeSeenRemovedBots", () => {
  it("keeps first-seen order and never drops a bot", () => {
    const a = removed({ botId: "a" });
    const b = removed({ botId: "b" });
    const c = removed({ botId: "c" });
    const first = mergeSeenRemovedBots([], [a, b]);
    expect(first.map((bot) => bot.botId)).toEqual(["a", "b"]);
    expect(mergeSeenRemovedBots(first, [c, b]).map((bot) => bot.botId)).toEqual(["a", "b", "c"]);
    expect(mergeSeenRemovedBots(first, [b])).toBe(first);
  });
});
