import { describe, expect, it } from "@effect/vitest";

import {
  DESTRUCTIVE_WORDS,
  INLINE_MAX_LABEL_LENGTH,
  answersForChoice,
  hasDestructiveWord,
  inlineVerdict,
  type PendingQuestion,
} from "./safeAnswer.ts";

const option = (label: string, description = "A plain choice", value?: string) => ({
  label,
  description,
  ...(value === undefined ? {} : { value }),
});

const question = (patch: Partial<PendingQuestion> = {}): PendingQuestion => ({
  id: "q1",
  header: "Dinner",
  question: "Which table should I book?",
  options: [option("Window"), option("Bar")],
  ...patch,
});

const labelsOf = (verdict: ReturnType<typeof inlineVerdict>) =>
  verdict._tag === "Inline" ? verdict.labels : verdict.reason;

describe("inlineVerdict", () => {
  it("offers a plain single-select question with one to three short options", () => {
    for (const count of [1, 2, 3]) {
      const options = ["Window", "Bar", "Patio"].slice(0, count).map((label) => option(label));
      expect(labelsOf(inlineVerdict("question", [question({ options })]))).toEqual(
        options.map((entry) => entry.label),
      );
    }
  });

  it("refuses every request kind except a question", () => {
    const expected = {
      approval: "approval-request",
      "sign-in": "sign-in-request",
      secret: "secret-request",
      "chat-reply": "not-a-question",
      failure: "not-a-question",
      task: "not-a-question",
      test: "not-a-question",
    } as const;
    for (const [kind, reason] of Object.entries(expected)) {
      expect(inlineVerdict(kind as keyof typeof expected, [question()])).toEqual({
        _tag: "Refused",
        reason,
      });
    }
  });

  it("refuses no question and several questions", () => {
    expect(labelsOf(inlineVerdict("question", []))).toBe("several-questions");
    expect(labelsOf(inlineVerdict("question", [question(), question({ id: "q2" })]))).toBe(
      "several-questions",
    );
  });

  it("refuses multi-select, even with a single option", () => {
    expect(
      labelsOf(
        inlineVerdict("question", [question({ multiSelect: true, options: [option("A")] })]),
      ),
    ).toBe("multi-select");
    expect(labelsOf(inlineVerdict("question", [question({ multiSelect: false })]))).toEqual([
      "Window",
      "Bar",
    ]);
  });

  it("refuses zero options and more than three", () => {
    expect(labelsOf(inlineVerdict("question", [question({ options: [] })]))).toBe("option-count");
    expect(
      labelsOf(
        inlineVerdict("question", [
          question({ options: ["A", "B", "C", "D"].map((label) => option(label)) }),
        ]),
      ),
    ).toBe("option-count");
  });

  it("accepts a label of exactly the limit and refuses one character more", () => {
    const exact = "a".repeat(INLINE_MAX_LABEL_LENGTH);
    expect(labelsOf(inlineVerdict("question", [question({ options: [option(exact)] })]))).toEqual([
      exact,
    ]);
    expect(
      labelsOf(inlineVerdict("question", [question({ options: [option(`${exact}a`)] })])),
    ).toBe("label-too-long");
  });

  it("counts characters, not UTF-16 units, so an emoji label is not cut short", () => {
    const label = "🍽".repeat(INLINE_MAX_LABEL_LENGTH);
    expect(labelsOf(inlineVerdict("question", [question({ options: [option(label)] })]))).toEqual([
      label,
    ]);
  });

  it("refuses two options a person could not tell apart", () => {
    expect(
      labelsOf(
        inlineVerdict("question", [question({ options: [option("Yes"), option(" Yes ")] })]),
      ),
    ).toBe("duplicate-label");
  });

  it("refuses a destructive word in a label, a description, or the question itself", () => {
    expect(
      labelsOf(inlineVerdict("question", [question({ options: [option("Delete it")] })])),
    ).toBe("destructive-word");
    expect(
      labelsOf(
        inlineVerdict("question", [
          question({ options: [option("Yes", "This will overwrite the file")] }),
        ]),
      ),
    ).toBe("destructive-word");
    expect(
      labelsOf(inlineVerdict("question", [question({ question: "Should I drop the table?" })])),
    ).toBe("destructive-word");
  });
});

describe("hasDestructiveWord", () => {
  it.each(DESTRUCTIVE_WORDS)("matches %s at the start of a word in any case", (word) => {
    expect(hasDestructiveWord(word)).toBe(true);
    expect(hasDestructiveWord(word.toUpperCase())).toBe(true);
    expect(hasDestructiveWord(`Please ${word} it now`)).toBe(true);
    expect(hasDestructiveWord(`${word}d, ${word}ing, ${word}s`)).toBe(true);
  });

  it("matches a phrase across spaces and hyphens", () => {
    expect(hasDestructiveWord("Sign out")).toBe(true);
    expect(hasDestructiveWord("sign-out")).toBe(true);
    expect(hasDestructiveWord("SIGNOUT")).toBe(true);
    expect(hasDestructiveWord("force-push")).toBe(true);
  });

  it("does not match a word that merely contains one", () => {
    for (const text of ["Window", "Bar", "Yes", "No", "Later", "Skip it", "Keep both", "Sign in"]) {
      expect(hasDestructiveWord(text)).toBe(false);
    }
    expect(hasDestructiveWord("undeleted")).toBe(false);
    expect(hasDestructiveWord("backdrop")).toBe(false);
  });
});

describe("answersForChoice", () => {
  it("answers with the option's value when it has one, else its label", () => {
    const options = [option("Window", "By the glass", "table-window"), option("Bar")];
    const questions = [question({ options })];
    expect(answersForChoice(questions, "Window")).toEqual({ q1: "table-window" });
    expect(answersForChoice(questions, " Bar ")).toEqual({ q1: "Bar" });
  });

  it("answers nothing for a label the notification did not offer", () => {
    expect(answersForChoice([question()], "Patio")).toBeNull();
    expect(answersForChoice([question()], "window")).toBeNull();
    expect(answersForChoice([], "Window")).toBeNull();
  });
});
