import { describe, expect, it } from "@effect/vitest";

import {
  approvalDetail,
  cappedLine,
  chatNeedsInputBody,
  chatNeedsInputTitle,
  CHAT_NEEDS_INPUT_LABEL,
  firstQuestionText,
  oneLine,
} from "./chatNeedsInput.ts";

describe("chat_needs_input wording", () => {
  it("opens the body with the kind and then what is asked", () => {
    expect(chatNeedsInputBody("question", "Which table should I book for Saturday?")).toBe(
      "Needs your answer: Which table should I book for Saturday?",
    );
    expect(chatNeedsInputBody("approval", "rm -rf build")).toBe("Needs approval: rm -rf build");
    expect(chatNeedsInputBody("sign-in", "skyfare.example")).toBe(
      "Needs a sign-in: skyfare.example",
    );
    expect(chatNeedsInputBody("secret", "OPENAI_API_KEY")).toBe("Needs a secret: OPENAI_API_KEY");
    // Nothing to name: the kind alone, never a dangling colon.
    expect(chatNeedsInputBody("approval", "")).toBe("Needs approval");
    expect(chatNeedsInputBody("question", "   ")).toBe("Needs your answer");
  });

  it("keeps every body one line, capped", () => {
    expect(oneLine("a\n  b\tc ")).toBe("a b c");
    const long = chatNeedsInputBody("question", "x".repeat(400));
    expect(long.length).toBeLessThanOrEqual("Needs your answer: ".length + 140);
    expect(long.endsWith("…")).toBe(true);
    expect(cappedLine("", 10)).toBe("");
    expect(cappedLine("exactlyten", 10)).toBe("exactlyten");
  });

  it("names the bot and the chat, and cuts a long chat title", () => {
    expect(chatNeedsInputTitle("Juno", "Weekend in Lisbon")).toBe("Juno · Weekend in Lisbon");
    // No chat title: the bot alone, never a trailing separator.
    expect(chatNeedsInputTitle("Juno", "  ")).toBe("Juno");
    expect(chatNeedsInputTitle("Juno", "y".repeat(200))).toBe(`Juno · ${"y".repeat(59)}…`);
  });

  it("has a label for each kind", () => {
    expect(Object.keys(CHAT_NEEDS_INPUT_LABEL).toSorted()).toEqual([
      "approval",
      "question",
      "secret",
      "sign-in",
    ]);
  });
});

describe("what a request says", () => {
  it("takes the first question the provider asked", () => {
    expect(
      firstQuestionText([
        { id: "q1", header: "Dinner", question: "Which table should I book?" },
        { id: "q2", header: "Time", question: "What time?" },
      ]),
    ).toBe("Which table should I book?");
    // A blank first question falls through to the next one.
    expect(
      firstQuestionText([
        { id: "q1", question: "  " },
        { id: "q2", question: "What time?" },
      ]),
    ).toBe("What time?");
    expect(firstQuestionText(undefined)).toBe("");
    expect(firstQuestionText([])).toBe("");
    expect(firstQuestionText([{ id: "q1" }])).toBe("");
  });

  it("takes the command an approval is about, else the app, else nothing", () => {
    expect(approvalDetail({ detail: "npm run deploy" })).toBe("npm run deploy");
    expect(approvalDetail({ appName: "Vercel" })).toBe("Vercel");
    expect(approvalDetail({ detail: "  ", appName: "Vercel" })).toBe("Vercel");
    // Never the activity's own summary ("Command approval requested"): the
    // body would repeat the kind without saying what it is.
    expect(approvalDetail({})).toBe("");
  });
});
