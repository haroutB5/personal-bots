import type { PersonalMemoryCard } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildConversationItems, placeMemoryCards } from "./conversationModel";
import {
  deriveMemoryCards,
  memoryCardButtons,
  memoryCardHeadline,
  memoryCardSettledLine,
} from "./memoryCards";

const botName = (botId: string) => (botId === "b1" ? "CTO" : undefined);

const card = (overrides: Partial<PersonalMemoryCard> = {}): PersonalMemoryCard =>
  ({
    changeId: 1,
    changeHash: "h1",
    threadId: "t1",
    action: "save",
    proposedBy: "bot:b1",
    content: "Use British spelling.",
    kind: "preference",
    scope: "team",
    scopeId: "dev",
    targets: [],
    status: "pending",
    createdAt: DateTime.makeUnsafe("2026-10-02T10:00:30Z"),
    decidedAt: null,
    ...overrides,
  }) as PersonalMemoryCard;

describe("memory card wording", () => {
  it("says who wants to save what, for whom", () => {
    expect(memoryCardHeadline(card(), botName)).toBe("CTO wants to save a preference for Dev team");
    expect(
      memoryCardHeadline(card({ kind: "note", scope: "shared", scopeId: null }), botName),
    ).toBe("CTO wants to save a note for All bots");
    expect(memoryCardHeadline(card({ proposedBy: "bot:gone" }), botName)).toBe(
      "A bot wants to save a preference for Dev team",
    );
    expect(memoryCardHeadline(card({ action: "forget" }), botName)).toBe("CTO asks to forget");
  });

  it("names the buttons for each action", () => {
    expect(memoryCardButtons("save")).toEqual({ approve: "Save", reject: "Don't save" });
    expect(memoryCardButtons("forget")).toEqual({ approve: "Forget", reject: "Keep it" });
  });

  it("folds a decided card to one line", () => {
    expect(memoryCardSettledLine(card())).toBeNull();
    expect(memoryCardSettledLine(card({ status: "approved" }))).toBe("Saved");
    expect(memoryCardSettledLine(card({ status: "rejected" }))).toBe("Not saved");
    expect(memoryCardSettledLine(card({ action: "forget", status: "approved" }))).toBe("Forgotten");
    expect(memoryCardSettledLine(card({ action: "forget", status: "rejected" }))).toBe("Kept");
  });
});

describe("memory card placement", () => {
  const entry = (id: string, createdAt: string) =>
    ({
      id,
      kind: "message",
      createdAt,
      message: { id, role: "assistant", text: id, createdAt, streaming: false },
    }) as never;

  it("keeps this chat's cards, oldest first", () => {
    const items = deriveMemoryCards(
      [
        card({ changeId: 2, createdAt: DateTime.makeUnsafe("2026-10-02T10:05:00Z") }),
        card({ changeId: 3, threadId: "other" }),
        card({ changeId: 1 }),
      ],
      "t1",
    );
    expect(items.map((item) => item.changeId)).toEqual([1, 2]);
    expect(items[0]!.pending).toBe(true);
  });

  it("places a decided card at its time and a pending one at the end", () => {
    const base = buildConversationItems([
      entry("a", "2026-10-02T10:00:00.000Z"),
      entry("b", "2026-10-02T10:01:00.000Z"),
    ]);
    const cards = deriveMemoryCards(
      [card({ changeId: 1, status: "approved" }), card({ changeId: 2 })],
      "t1",
    );
    const ids = placeMemoryCards(base, cards).map((item) => item.id);
    expect(ids.indexOf("memory-change:1")).toBe(ids.indexOf("a") + 1);
    expect(ids.indexOf("memory-change:1")).toBeLessThan(ids.indexOf("b"));
    expect(ids.at(-1)).toBe("memory-change:2");
  });
});
