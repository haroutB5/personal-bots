import { describe, expect, it } from "@effect/vitest";

import {
  buildTidyPrompt,
  decisionsFromJudge,
  exactDuplicateDecisions,
  memorySimilarity,
  RECENT_USER_EDIT_MS,
  validateDecisions,
  type TidyEntry,
} from "./memoryTidy.ts";
import { nightlyRunDue, tidyModel } from "./PersonalMemoryTidyService.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T03:30:00.000Z");

const entry = (
  memoryId: string,
  content: string,
  overrides: Partial<TidyEntry> = {},
): TidyEntry => ({
  memoryId,
  scope: "shared",
  scopeId: null,
  kind: "note",
  content,
  source: "bot:cto",
  updatedAtMs: NOW - 5 * DAY,
  version: 1,
  ...overrides,
});

describe("memorySimilarity", () => {
  it("scores two versions of the same note above unrelated notes", () => {
    const older =
      "Dev team models (2026-09-28): Harout moved Frontend, Backend and DevOps to Claude Sonnet 5.5 high. CTO stays Opus 5.5 medium.";
    const newer =
      "Dev team models (update 2026-09-29): QA, DevOps and Security run GPT-6.1 Sol high. Frontend and Backend stay on Claude Sonnet 5.5 high; CTO on Opus 5.5.";
    const unrelated = "Harout usually cooks 90 g of dry pasta per portion.";
    expect(memorySimilarity(older, newer)).toBeGreaterThan(0.3);
    expect(memorySimilarity(older, unrelated)).toBeLessThan(0.1);
  });
});

describe("exactDuplicateDecisions", () => {
  it("keeps the newest copy of the same text and never folds across scopes", () => {
    const decisions = exactDuplicateDecisions([
      entry("old", "Favourite drink: green tea.", { updatedAtMs: NOW - 9 * DAY }),
      entry("new", "favourite drink:  Green tea.", { updatedAtMs: NOW - 2 * DAY }),
      entry("bot", "Favourite drink: green tea.", { scope: "bot", scopeId: "cfo" }),
    ]);
    expect(decisions).toEqual([
      {
        action: "supersede",
        memoryIds: ["old"],
        by: "new",
        reason: "Exact duplicate of a newer entry.",
      },
    ]);
  });
});

describe("validateDecisions", () => {
  const entries = [
    entry("a", "Rule A"),
    entry("b", "Rule A, restated"),
    entry("c", "Rule C"),
    entry("d", "Rule D"),
    entry("e", "Rule E"),
    entry("f", "Rule F"),
  ];

  it("applies a sound merge and supersede", () => {
    const result = validateDecisions(
      entries,
      [
        {
          action: "merge",
          memoryIds: ["a", "b"],
          content: "Rule A (merged).",
          reason: "Same rule.",
        },
        { action: "supersede", memoryIds: ["c"], by: "d", reason: "D replaced C." },
      ],
      NOW,
    );
    expect(result.apply).toHaveLength(2);
    expect(result.left).toEqual([]);
  });

  it("leaves a change naming an entry outside the scope (another bot's, say)", () => {
    const result = validateDecisions(
      entries,
      [{ action: "supersede", memoryIds: ["other-bots-entry"], by: "a", reason: "Same." }],
      NOW,
    );
    expect(result.apply).toEqual([]);
    expect(result.left[0]!.reason).toContain("not in this scope");
  });

  it("leaves an entry the user edited in the last day: their edit wins", () => {
    const edited = [
      entry("u", "User's rule", { updatedAtMs: NOW - DAY / 2, version: 2 }),
      ...entries,
    ];
    const result = validateDecisions(
      edited,
      [{ action: "supersede", memoryIds: ["u"], by: "a", reason: "Older." }],
      NOW,
    );
    expect(result.apply).toEqual([]);
    expect(result.left[0]!.reason).toContain("your edit wins");
    // A day later the same change is allowed.
    const later = validateDecisions(
      edited,
      [{ action: "supersede", memoryIds: ["u"], by: "a", reason: "Older." }],
      NOW + RECENT_USER_EDIT_MS,
    );
    expect(later.apply).toHaveLength(1);
  });

  it("leaves overlapping changes, secret-looking merges and more than half the scope", () => {
    const result = validateDecisions(
      entries,
      [
        { action: "supersede", memoryIds: ["a"], by: "b", reason: "Dup." },
        { action: "merge", memoryIds: ["b", "c"], content: "B and C.", reason: "Overlaps." },
        { action: "merge", memoryIds: ["d", "e"], content: "token: abc123", reason: "Leaky." },
        { action: "supersede", memoryIds: ["c", "d"], by: "e", reason: "Fine." },
        { action: "supersede", memoryIds: ["f"], by: "e", reason: "Too many." },
      ],
      NOW,
    );
    expect(result.apply.map((decision) => decision.memoryIds)).toEqual([["a"], ["c", "d"]]);
    expect(result.left.map((decision) => decision.reason)).toEqual([
      "Overlaps an earlier change in this run (Overlaps.)",
      "Merged text looks like it carries a secret (Leaky.)",
      "Too many changes for one night; left for the next run (Too many.)",
    ]);
  });

  it("only ever proposes merge, supersede or leave: there is no delete", () => {
    const result = validateDecisions(
      entries,
      [{ action: "leave", memoryIds: ["a", "b"], reason: "Unsure whether these are one rule." }],
      NOW,
    );
    expect(result.left).toEqual([
      { action: "leave", memoryIds: ["a", "b"], reason: "Unsure whether these are one rule." },
    ]);
  });
});

describe("prompt and model output", () => {
  it("numbers entries with dates and maps refs back to ids, keeping unknown refs visible", () => {
    const { prompt, refs } = buildTidyPrompt({
      scopeLabel: "shared",
      entries: [entry("id-1", "Rule one"), entry("id-2", "Rule two")],
      todayIso: "2026-10-02",
      appVersion: "1.60.19",
    });
    expect(prompt).toContain("E1 | note | ");
    expect(prompt).toContain("| Rule two");
    expect(prompt).toContain("live at version 1.60.19");
    const decisions = decisionsFromJudge(
      {
        decisions: [
          { action: "supersede", memoryIds: ["e1"], by: "E2", reason: "Newer." },
          { action: "supersede", memoryIds: ["E9"], by: null, reason: "Gone." },
        ],
      },
      refs,
    );
    expect(decisions).toEqual([
      { action: "supersede", memoryIds: ["id-1"], by: "id-2", reason: "Newer." },
      { action: "supersede", memoryIds: ["unknown:E9"], by: null, reason: "Gone." },
    ]);
  });
});

describe("schedule and model", () => {
  it("is due once a day after 03:30 local time", () => {
    const at = (h: number, m: number, dayOffset = 0) => {
      const date = new Date(2026, 9, 2 + dayOffset, h, m);
      return date.getTime();
    };
    expect(nightlyRunDue(at(3, 29), null)).toBe(false);
    expect(nightlyRunDue(at(3, 30), null)).toBe(true);
    expect(nightlyRunDue(at(9, 0), at(3, 31))).toBe(false);
    expect(nightlyRunDue(at(3, 40, 1), at(3, 31))).toBe(true);
  });

  it("never runs on Fable, whatever the override says", () => {
    expect(tidyModel(undefined)).toBe("claude-sonnet-5-5");
    expect(tidyModel("claude-fable-5-1")).toBe("claude-sonnet-5-5");
    expect(tidyModel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });
});
