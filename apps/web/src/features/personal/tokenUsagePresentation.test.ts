import type { PersonalBotTokenUsageTotals, PersonalBotTokenUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTokenUsageTable,
  findTokenUsageWindow,
  formatShare,
  formatSplit,
  formatTokenCount,
  formatUpdated,
  formatWindowRange,
  isTokenUsagePending,
  splitOf,
  tokenUsageRowLabel,
  totalOf,
} from "./tokenUsagePresentation";

const totals = (
  uncached: number,
  cached: number,
  cacheWrite: number,
  output: number,
): PersonalBotTokenUsageTotals => ({
  uncachedInputTokens: uncached,
  cachedInputTokens: cached,
  cacheCreationTokens: cacheWrite,
  outputTokens: output,
});

const sum = (...parts: PersonalBotTokenUsageTotals[]): PersonalBotTokenUsageTotals =>
  totals(
    parts.reduce((n, p) => n + p.uncachedInputTokens, 0),
    parts.reduce((n, p) => n + p.cachedInputTokens, 0),
    parts.reduce((n, p) => n + p.cacheCreationTokens, 0),
    parts.reduce((n, p) => n + p.outputTokens, 0),
  );

const row = (botId: string, t: PersonalBotTokenUsageTotals, sessions = 1) =>
  ({ botId, totals: t, models: [], sessions }) as never;

function windowOf(
  rows: ReadonlyArray<ReturnType<typeof row>>,
  other: PersonalBotTokenUsageTotals = totals(0, 0, 0, 0),
): PersonalBotTokenUsageWindow {
  const all = sum(...rows.map((r: { totals: PersonalBotTokenUsageTotals }) => r.totals), other);
  return {
    id: "week",
    sinceDay: "2026-09-28",
    untilDay: "2026-10-04",
    rows,
    other: { totals: other, sessions: 0 },
    total: { totals: all, sessions: rows.length },
  };
}

const BOTS = [
  { botId: "cto", name: "CTO" },
  { botId: "backend", name: "Backend" },
  { botId: "qa", name: "QA" },
  { botId: "design", name: "Designer" },
  { botId: "watcher", name: "Watcher" },
];

describe("formatTokenCount", () => {
  it("is exact under a thousand and one decimal past it", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(842)).toBe("842");
    expect(formatTokenCount(1_000)).toBe("1.0k");
    expect(formatTokenCount(12_345)).toBe("12.3k");
    expect(formatTokenCount(120_400_000)).toBe("120.4M");
    expect(formatTokenCount(1_234_000_000)).toBe("1.2B");
  });

  it("moves a value that rounds up to the next unit", () => {
    expect(formatTokenCount(999_949)).toBe("999.9k");
    expect(formatTokenCount(999_950)).toBe("1.0M");
    expect(formatTokenCount(999_960_000)).toBe("1.0B");
  });

  it("reads nothing, negative or broken as 0", () => {
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatShare", () => {
  it("rounds, and says so when a real share is under one percent", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.2)).toBe("<1%");
    expect(formatShare(1)).toBe("1%");
    expect(formatShare(34.6)).toBe("35%");
    expect(formatShare(100)).toBe("100%");
  });
});

describe("the split", () => {
  it("adds up to the headline total, cache writes counting as input", () => {
    const t = totals(10, 800, 40, 25);
    expect(totalOf(t)).toBe(875);
    const split = splitOf(t);
    expect(split).toEqual({ input: 50, cached: 800, output: 25 });
    expect(split.input + split.cached + split.output).toBe(totalOf(t));
    expect(formatSplit(split)).toBe("in 50 · cached 800 · out 25");
  });
});

describe("buildTokenUsageTable", () => {
  const listed = new Set(BOTS.map((bot) => bot.botId));

  it("ranks the bots from most to fewest tokens and chips only the top three", () => {
    const table = buildTokenUsageTable({
      window: windowOf([
        row("qa", totals(0, 0, 0, 400)),
        row("cto", totals(0, 0, 0, 1000)),
        row("backend", totals(0, 0, 0, 700)),
        row("design", totals(0, 0, 0, 100)),
      ]),
      bots: BOTS,
      listedBotIds: listed,
    });
    expect(table.rows.map((r) => [r.botId, r.rank])).toEqual([
      ["cto", 1],
      ["backend", 2],
      ["qa", 3],
      ["design", null],
      // Listed, no use: last, no rank.
      ["watcher", null],
    ]);
    expect(table.total).toBe(2200);
  });

  it("gives each row its share of everything counted, Other included", () => {
    const table = buildTokenUsageTable({
      window: windowOf([row("cto", totals(0, 0, 0, 750))], totals(0, 0, 0, 250)),
      bots: BOTS,
      listedBotIds: new Set(),
    });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.sharePercent).toBe(75);
    expect(table.other).toEqual({ tokens: 250, sharePercent: 25 });
    expect(table.total).toBe(1000);
  });

  it("lists every listed bot, with zeros for the ones that used nothing", () => {
    const table = buildTokenUsageTable({
      window: windowOf([row("cto", totals(0, 0, 0, 10))]),
      bots: BOTS,
      listedBotIds: listed,
    });
    expect(table.rows).toHaveLength(5);
    const idle = table.rows.filter((r) => r.tokens === 0).map((r) => r.name);
    // Ties sort by name.
    expect(idle).toEqual(["Backend", "Designer", "QA", "Watcher"]);
    expect(table.rows.find((r) => r.botId === "watcher")).toMatchObject({
      tokens: 0,
      sharePercent: 0,
      rank: null,
    });
  });

  it("shows a bot outside the listed ones when it has use, but not when it has none", () => {
    const table = buildTokenUsageTable({
      window: windowOf([row("design", totals(0, 0, 0, 10))]),
      bots: BOTS,
      listedBotIds: new Set(["cto"]),
    });
    expect(table.rows.map((r) => r.botId)).toEqual(["design", "cto"]);
  });

  it("counts a bot this screen cannot open under Other, so the rows still add up", () => {
    const table = buildTokenUsageTable({
      window: windowOf(
        [row("cto", totals(0, 0, 0, 600)), row("removed-bot", totals(0, 0, 0, 300))],
        totals(0, 0, 0, 100),
      ),
      bots: BOTS,
      listedBotIds: new Set(),
    });
    expect(table.rows.map((r) => r.botId)).toEqual(["cto"]);
    expect(table.other.tokens).toBe(400);
    const rowsTotal = table.rows.reduce((n, r) => n + r.tokens, 0);
    expect(rowsTotal + table.other.tokens).toBe(table.total);
  });

  it("is empty and share-free for a window with no use", () => {
    const table = buildTokenUsageTable({
      window: windowOf([]),
      bots: BOTS,
      listedBotIds: listed,
    });
    expect(table.total).toBe(0);
    expect(table.rows.every((r) => r.tokens === 0 && r.sharePercent === 0 && r.rank === null)).toBe(
      true,
    );
    expect(table.other).toEqual({ tokens: 0, sharePercent: 0 });
  });

  it("keeps the window's days for the hint line", () => {
    const table = buildTokenUsageTable({ window: windowOf([]), bots: BOTS, listedBotIds: listed });
    expect(table.sinceDay).toBe("2026-09-28");
    expect(table.untilDay).toBe("2026-10-04");
  });
});

describe("labels", () => {
  it("says how old the numbers are", () => {
    const now = Date.parse("2026-10-04T12:00:00.000Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(formatUpdated(null, now)).toBeNull();
    expect(formatUpdated("not a date", now)).toBeNull();
    expect(formatUpdated(ago(20_000), now)).toBe("Updated just now");
    expect(formatUpdated(ago(4 * 60_000), now)).toBe("Updated 4m ago");
    expect(formatUpdated(ago(3 * 3_600_000), now)).toBe("Updated 3h ago");
    expect(formatUpdated(ago(50 * 3_600_000), now)).toBe("Updated 2d ago");
    // A clock a little behind the server's never reads as the future.
    expect(formatUpdated(ago(-5_000), now)).toBe("Updated just now");
  });

  it("names the days a window covers", () => {
    expect(formatWindowRange("2026-09-05", "2026-10-04")).toBe("5 Sep to 4 Oct");
    expect(formatWindowRange("2026-10-04", "2026-10-04")).toBe("4 Oct");
  });

  it("reads a row to a screen reader with its rank, share and split", () => {
    const table = buildTokenUsageTable({
      window: windowOf([row("cto", totals(10, 800, 40, 25))]),
      bots: BOTS,
      listedBotIds: new Set(),
    });
    expect(tokenUsageRowLabel(table.rows[0]!)).toBe(
      "CTO: 875 tokens, 100% of the total. Number 1 user. in 50 · cached 800 · out 25. Open CTO.",
    );
    const idle = buildTokenUsageTable({
      window: windowOf([]),
      bots: BOTS,
      listedBotIds: new Set(["qa"]),
    });
    expect(tokenUsageRowLabel(idle.rows[0]!)).toBe("QA: no tokens used. Open QA.");
  });

  it("polls while the server is counting, and only then", () => {
    expect(isTokenUsagePending("warming")).toBe(true);
    expect(isTokenUsagePending("refreshing")).toBe(true);
    expect(isTokenUsagePending("ready")).toBe(false);
    expect(isTokenUsagePending("unavailable")).toBe(false);
    expect(isTokenUsagePending(undefined)).toBe(false);
  });

  it("finds a window by id and is null before the server sends any", () => {
    expect(findTokenUsageWindow(null, "week")).toBeNull();
    expect(
      findTokenUsageWindow({ status: "warming", readAt: null, windows: [] }, "week"),
    ).toBeNull();
    const week = windowOf([]);
    expect(
      findTokenUsageWindow(
        { status: "ready", readAt: "2026-10-04T12:00:00.000Z", windows: [week] },
        "week",
      ),
    ).toBe(week);
  });
});
