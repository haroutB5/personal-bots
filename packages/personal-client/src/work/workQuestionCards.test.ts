import { describe, expect, it } from "vite-plus/test";

import { answerNeedsConfirm, buildWorkQuestionCards } from "./workQuestionCards.ts";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");

const base = {
  botName: () => "Builder",
  chatTitle: () => "Branch cleanup",
  hiddenThreadIds: new Set<string>(),
  nowMs: NOW,
};

const question = {
  threadId: "thread-a",
  botId: "bot-a",
  messageId: "m-1",
  askedAtMs: Date.parse("2026-11-15T11:58:30.000Z"),
  question: "Delete 9 merged branches?",
  options: ["Yes, delete", "Keep"],
};

describe("buildWorkQuestionCards", () => {
  it("draws two or three options as one button each with the bot and chat line", () => {
    const cards = buildWorkQuestionCards({ ...base, questions: [question] });

    expect(cards).toEqual([
      {
        key: "m-1",
        threadId: "thread-a",
        botId: "bot-a",
        messageId: "m-1",
        askedAtMs: question.askedAtMs,
        title: "Delete 9 merged branches?",
        detail: "Builder · Branch cleanup · asked 2 min ago",
        actions: { kind: "choices", choices: ["Yes, delete", "Keep"] },
      },
    ]);
  });

  it("draws four to six options as a count, not a row of buttons", () => {
    const cards = buildWorkQuestionCards({
      ...base,
      questions: [{ ...question, options: ["A", "B", "C", "D", "E"] }],
    });

    expect(cards[0]?.actions).toEqual({ kind: "many", count: 5 });
  });

  it("gives a hidden-previews question only the chat", () => {
    const cards = buildWorkQuestionCards({
      ...base,
      questions: [{ ...question, question: null, options: null }],
    });

    expect(cards[0]?.title).toBe("Builder asked a question");
    expect(cards[0]?.actions).toEqual({ kind: "chat" });
  });

  it("hides a question whose chat is already working or waiting", () => {
    const cards = buildWorkQuestionCards({
      ...base,
      questions: [question, { ...question, threadId: "thread-b", messageId: "m-2" }],
      hiddenThreadIds: new Set(["thread-a"]),
    });

    expect(cards.map((card) => card.key)).toEqual(["m-2"]);
  });

  it("keeps the newest question first", () => {
    const cards = buildWorkQuestionCards({
      ...base,
      questions: [
        { ...question, messageId: "older", askedAtMs: NOW - 60_000 },
        { ...question, messageId: "newer", askedAtMs: NOW - 30_000 },
      ],
    });

    expect(cards.map((card) => card.key)).toEqual(["newer", "older"]);
  });
});

describe("answerNeedsConfirm", () => {
  it("asks before a destructive choice and sends a safe one at once", () => {
    expect(answerNeedsConfirm("Yes, delete")).toBe(true);
    expect(answerNeedsConfirm("Keep")).toBe(false);
  });
});
