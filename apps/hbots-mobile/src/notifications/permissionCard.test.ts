import { describe, expect, it } from "vite-plus/test";

import {
  answered,
  backgroundDone,
  cardShown,
  cardView,
  cardWords,
  FRESH_MEMORY,
  leftChat,
  messageSent,
  NOT_NOW_MS,
  notNow,
  parseMemory,
  serializeMemory,
  type CardFacts,
  type CardMemory,
} from "./permissionCard";

const NOW = 1_000_000;
const facts = (over: Partial<CardFacts> = {}): CardFacts => ({
  now: NOW,
  notificationsEnabled: false,
  questionOpen: false,
  canAsk: true,
  ...over,
});
const armed: CardMemory = leftChat(messageSent(FRESH_MEMORY));

describe("when the card shows", () => {
  it("never shows on launch or in a chat the owner has not sent anything in", () => {
    expect(cardView(FRESH_MEMORY, facts())).toEqual({ kind: "none" });
    expect(cardView(leftChat(FRESH_MEMORY), facts())).toEqual({ kind: "none" });
  });

  it("shows after a message was sent and the chat was left", () => {
    expect(cardView(messageSent(FRESH_MEMORY), facts())).toEqual({ kind: "none" });
    expect(cardView(armed, facts())).toEqual({ kind: "ask" });
  });

  it("shows at once when a bot asks a question while the app is open", () => {
    expect(cardView(FRESH_MEMORY, facts({ questionOpen: true }))).toEqual({ kind: "ask" });
  });

  it("stays away when notifications are already on", () => {
    expect(cardView(armed, facts({ notificationsEnabled: true }))).toEqual({ kind: "none" });
  });

  it("stays away when the phone cannot be asked", () => {
    expect(cardView(armed, facts({ canAsk: false }))).toEqual({ kind: "none" });
  });
});

describe("Not now, refusal and the two-show cap", () => {
  it("Not now hides the card for 7 days, then it can come back", () => {
    const hidden = notNow(armed, NOW);
    expect(cardView(hidden, facts({ questionOpen: true }))).toEqual({ kind: "none" });
    expect(cardView(hidden, facts({ now: NOW + NOT_NOW_MS - 1, questionOpen: true }))).toEqual({
      kind: "none",
    });
    expect(cardView(hidden, facts({ now: NOW + NOT_NOW_MS, questionOpen: true }))).toEqual({
      kind: "ask",
    });
  });

  it("a refusal closes the card for good, even for a question", () => {
    for (const answer of ["denied", "blocked", "not-needed"] as const) {
      const closed = answered(armed, answer);
      expect(cardView(closed, facts({ questionOpen: true, now: NOW * 1000 }))).toEqual({
        kind: "none",
      });
    }
  });

  it("shows at most twice ever", () => {
    const once = cardShown(armed);
    expect(cardView(once, facts())).toEqual({ kind: "ask" });
    const twice = cardShown(once);
    expect(cardView(twice, facts({ questionOpen: true }))).toEqual({ kind: "none" });
  });
});

describe("granting", () => {
  it("moves to the battery step, which finishes with Done", () => {
    const granted = answered(armed, "granted");
    expect(cardView(granted, facts({ notificationsEnabled: true }))).toEqual({
      kind: "background",
    });
    const done = backgroundDone(granted);
    expect(cardView(done, facts({ notificationsEnabled: true }))).toEqual({ kind: "none" });
    expect(cardView(done, facts({ questionOpen: true }))).toEqual({ kind: "none" });
  });
});

describe("saved memory", () => {
  it("round-trips", () => {
    const memory = cardShown(notNow(armed, NOW));
    expect(parseMemory(serializeMemory(memory))).toEqual(memory);
  });

  it("reads anything else as a fresh memory", () => {
    expect(parseMemory(null)).toEqual(FRESH_MEMORY);
    expect(parseMemory("")).toEqual(FRESH_MEMORY);
    expect(parseMemory("{nope")).toEqual(FRESH_MEMORY);
    expect(parseMemory(JSON.stringify({ ...FRESH_MEMORY, shown: -1 }))).toEqual(FRESH_MEMORY);
    expect(parseMemory(JSON.stringify({ ...FRESH_MEMORY, step: "x" }))).toEqual(FRESH_MEMORY);
  });
});

describe("words", () => {
  it("promises replies only when push can deliver them", () => {
    expect(cardWords("ask", "Juno", true).headline).toBe("Get told when Juno replies");
    expect(cardWords("ask", "Juno", false).headline).toBe("See when Juno is working");
    expect(cardWords("background", "Juno", true).primary).toBe("Open settings");
  });
});
