import { describe, expect, it } from "@effect/vitest";

import type { BotUsageCell } from "../usage/botUsage.ts";
import {
  buildSessionOwners,
  computeTokenUsageWindows,
  dayInZone,
  sessionIdFromResumeCursor,
  sessionKey,
  shiftDay,
  tokenUsageWindowRanges,
} from "./botTokenUsage.ts";

function cell(overrides: Partial<BotUsageCell> = {}): BotUsageCell {
  return {
    day: "2026-10-04",
    provider: "claude",
    model: "claude-opus-5-5",
    sessionId: "s-ada",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 100,
      cacheCreationTokens: 5,
      outputTokens: 20,
    },
    records: 1,
    ...overrides,
  };
}

const OWNERS = new Map([
  [sessionKey("claude", "s-ada"), "bot-ada"],
  [sessionKey("claude", "s-ada-2"), "bot-ada"],
  [sessionKey("codex", "s-bo"), "bot-bo"],
  [sessionKey("claude", "s-gone"), "bot-removed"],
]);
const ACTIVE = new Set(["bot-ada", "bot-bo", "bot-idle"]);

function windows(cells: ReadonlyArray<BotUsageCell>, today = "2026-10-04") {
  return computeTokenUsageWindows({ cells, owners: OWNERS, activeBotIds: ACTIVE, today });
}

const tokens = (totals: BotUsageCell["totals"]) =>
  totals.uncachedInputTokens +
  totals.cachedInputTokens +
  totals.cacheCreationTokens +
  totals.outputTokens;

describe("resume cursors", () => {
  it("reads the session id each provider keeps in its cursor", () => {
    expect(
      sessionIdFromResumeCursor(
        "claude",
        JSON.stringify({ resume: "abc", threadId: "t1", turnCount: 3 }),
      ),
    ).toBe("abc");
    expect(sessionIdFromResumeCursor("codex", JSON.stringify({ threadId: "019a" }))).toBe("019a");
    expect(
      sessionIdFromResumeCursor(
        "opencode",
        JSON.stringify({ schemaVersion: 1, sessionId: "ses_1" }),
      ),
    ).toBe("ses_1");
  });

  it("returns null for a cursor with no usable id", () => {
    expect(sessionIdFromResumeCursor("claude", null)).toBeNull();
    expect(sessionIdFromResumeCursor("claude", "not json")).toBeNull();
    expect(sessionIdFromResumeCursor("claude", "42")).toBeNull();
    expect(sessionIdFromResumeCursor("claude", JSON.stringify({ threadId: "t1" }))).toBeNull();
    expect(sessionIdFromResumeCursor("claude", JSON.stringify({ resume: "" }))).toBeNull();
    // A Codex cursor has no `resume`, an OpenCode one no `threadId`.
    expect(sessionIdFromResumeCursor("codex", JSON.stringify({ resume: "x" }))).toBeNull();
  });

  it("maps sessions to bots by provider, skipping providers it cannot read", () => {
    const owners = buildSessionOwners([
      { botId: "a", providerName: "claudeAgent", resumeCursorJson: '{"resume":"s1"}' },
      { botId: "b", providerName: "codex", resumeCursorJson: '{"threadId":"s2"}' },
      { botId: "c", providerName: "opencode", resumeCursorJson: '{"sessionId":"s3"}' },
      { botId: "d", providerName: "cursor", resumeCursorJson: '{"resume":"s4"}' },
      { botId: "e", providerName: "claudeAgent", resumeCursorJson: null },
    ]);
    expect(owners.get(sessionKey("claude", "s1"))).toBe("a");
    expect(owners.get(sessionKey("codex", "s2"))).toBe("b");
    expect(owners.get(sessionKey("opencode", "s3"))).toBe("c");
    expect(owners.size).toBe(3);
    // The same id under another provider is another session.
    expect(owners.get(sessionKey("codex", "s1"))).toBeUndefined();
  });
});

describe("days", () => {
  it("shifts days across month and year edges", () => {
    expect(shiftDay("2026-10-04", -6)).toBe("2026-09-28");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDay("2027-01-03", -5)).toBe("2026-12-29");
    expect(shiftDay("2026-12-30", 3)).toBe("2027-01-02");
  });

  it("cuts the windows to end today: today, the last 7 days, the last 30", () => {
    expect(tokenUsageWindowRanges("2026-10-04")).toEqual([
      { id: "today", sinceDay: "2026-10-04", untilDay: "2026-10-04" },
      { id: "week", sinceDay: "2026-09-28", untilDay: "2026-10-04" },
      { id: "month", sinceDay: "2026-09-05", untilDay: "2026-10-04" },
    ]);
  });

  it("reads today in the caller's zone", () => {
    const instant = Date.parse("2026-10-04T23:30:00.000Z");
    expect(dayInZone(instant, "UTC")).toBe("2026-10-04");
    expect(dayInZone(instant, "Europe/London")).toBe("2026-10-05");
    expect(dayInZone(instant, "America/Los_Angeles")).toBe("2026-10-04");
    expect(dayInZone(instant, "Nowhere/Land")).toBe("2026-10-04");
  });
});

describe("windows", () => {
  it("puts each day in the windows that cover it", () => {
    const result = windows([
      cell({ day: "2026-10-04" }),
      cell({ day: "2026-09-28" }),
      cell({ day: "2026-09-27" }),
      cell({ day: "2026-09-05" }),
      cell({ day: "2026-09-04" }),
    ]);
    const byId = Object.fromEntries(result.map((window) => [window.id, window]));
    const sessionTokens = (id: string) => tokens(byId[id]!.total.totals);
    // One cell is 135 tokens.
    expect(sessionTokens("today")).toBe(135);
    expect(sessionTokens("week")).toBe(270);
    expect(sessionTokens("month")).toBe(135 * 4);
  });

  it("attributes sessions to their bot and sums the buckets", () => {
    const [today] = windows([
      cell(),
      cell({ sessionId: "s-ada-2", model: "claude-sonnet-5-5" }),
      cell({ provider: "codex", sessionId: "s-bo", model: "gpt-6-astra" }),
    ]);
    expect(today?.rows.map((row) => String(row.botId))).toEqual(["bot-ada", "bot-bo"]);
    const ada = today?.rows[0];
    expect(ada?.totals).toEqual({
      uncachedInputTokens: 20,
      cachedInputTokens: 200,
      cacheCreationTokens: 10,
      outputTokens: 40,
    });
    expect(ada?.sessions).toBe(2);
    expect(ada?.models.map((entry) => entry.model).toSorted()).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(today?.other).toEqual({
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
      },
      sessions: 0,
    });
  });

  it("sorts rows from most tokens to fewest", () => {
    const [today] = windows([
      cell({ provider: "codex", sessionId: "s-bo", totals: bigTotals(5000) }),
      cell(),
    ]);
    expect(today?.rows.map((row) => String(row.botId))).toEqual(["bot-bo", "bot-ada"]);
  });

  it("sends sessions with no live owner to other, and the total is rows plus other", () => {
    const [today] = windows([
      cell(),
      // No chat points at this session any more.
      cell({ sessionId: "s-unknown" }),
      // Its bot was removed.
      cell({ sessionId: "s-gone" }),
      // The transcript line had no session id.
      cell({ sessionId: "" }),
      // The same id under another provider is not Ada's session.
      cell({ provider: "codex", sessionId: "s-ada" }),
    ]);
    expect(today?.rows).toHaveLength(1);
    expect(today?.other.sessions).toBe(3);
    expect(tokens(today!.other.totals)).toBe(135 * 4);
    const rowTotal = today!.rows.reduce((sum, row) => sum + tokens(row.totals), 0);
    expect(tokens(today!.total.totals)).toBe(rowTotal + tokens(today!.other.totals));
    expect(today?.total.sessions).toBe(4);
  });

  it("gives a bot with no usage no row, and an empty window all zeros", () => {
    const [today, week, month] = windows([]);
    for (const window of [today, week, month]) {
      expect(window?.rows).toEqual([]);
      expect(tokens(window!.total.totals)).toBe(0);
      expect(window?.total.sessions).toBe(0);
    }
  });

  it("lists at most five models, most tokens first", () => {
    const models = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    const [today] = windows(
      models.map((model, index) => cell({ model, totals: bigTotals((index + 1) * 100) })),
    );
    expect(today?.rows[0]?.models.map((entry) => entry.model)).toEqual([
      "m7",
      "m6",
      "m5",
      "m4",
      "m3",
    ]);
  });
});

function bigTotals(output: number): BotUsageCell["totals"] {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: output,
  };
}
