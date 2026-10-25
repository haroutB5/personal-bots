import type {
  PersonalBotTokenUsageModel,
  PersonalBotTokenUsageTotals,
  PersonalBotTokenUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  barWidthPercent,
  buildTokenUsageTable,
  costViewOf,
  findTokenUsageWindow,
  formatCostCompact,
  formatBotMeta,
  formatCostFull,
  formatIdleBots,
  formatModelsAndShare,
  formatShare,
  formatSplit,
  formatTokenCount,
  formatUpdated,
  formatUsd,
  formatWindowSpan,
  isTokenUsagePending,
  normalizeModelName,
  providerColor,
  providerLabel,
  splitOf,
  tokenUsageBotButtonLabel,
  tokenUsageProviderLabel,
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

const model = (
  provider: UsageProviderKind,
  id: string,
  t: PersonalBotTokenUsageTotals,
  costUsd = 0,
  unpricedTokens = 0,
): PersonalBotTokenUsageModel => ({ provider, model: id, totals: t, costUsd, unpricedTokens });

const row = (
  botId: string,
  t: PersonalBotTokenUsageTotals,
  sessions = 1,
  models: ReadonlyArray<PersonalBotTokenUsageModel> = [],
) => ({ botId, totals: t, models, sessions }) as never;

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
    providers: [],
    other: { totals: other, costUsd: 0, unpricedTokens: 0, sessions: 0 },
    total: { totals: all, costUsd: 0, unpricedTokens: 0, sessions: rows.length },
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

describe("the API price estimate", () => {
  it("formats dollars compactly: cents to a thousand, whole dollars to ten thousand, then k", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.005)).toBe("$0.01");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(12.4)).toBe("$12.40");
    expect(formatUsd(999.99)).toBe("$999.99");
    expect(formatUsd(1234.56)).toBe("$1,235");
    expect(formatUsd(12_345)).toBe("$12.3k");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(-3)).toBe("$0.00");
  });

  it("tells priced, partly priced, not priced and nothing apart", () => {
    expect(costViewOf(1000, { costUsd: 12.4, unpricedTokens: 0 })).toEqual({
      kind: "priced",
      usd: 12.4,
    });
    expect(costViewOf(1000, { costUsd: 12.4, unpricedTokens: 400 })).toEqual({
      kind: "partial",
      usd: 12.4,
    });
    // Every token unpriced: not priced, never $0.00.
    expect(costViewOf(1000, { costUsd: 0, unpricedTokens: 1000 })).toEqual({ kind: "unpriced" });
    expect(costViewOf(0, { costUsd: 0, unpricedTokens: 0 })).toEqual({ kind: "none" });
    // A server that sends no cost (an older one) shows none, not zero.
    expect(costViewOf(1000, undefined)).toEqual({ kind: "none" });
    expect(costViewOf(1000, {})).toEqual({ kind: "none" });
  });

  it("words a partly priced total as '$12.40 + unpriced', short as '$12.40+'", () => {
    const partial = costViewOf(1000, { costUsd: 12.4, unpricedTokens: 1 });
    expect(formatCostFull(partial)).toBe("$12.40 + unpriced");
    expect(formatCostCompact(partial)).toBe("$12.40+");
    const none = costViewOf(1000, { costUsd: 0, unpricedTokens: 1000 });
    expect(formatCostFull(none)).toBe("not priced");
    expect(formatCostCompact(none)).toBe("not priced");
    expect(formatCostCompact({ kind: "none" })).toBe("");
    expect(formatCostFull(costViewOf(1000, { costUsd: 3, unpricedTokens: 0 }))).toBe("$3.00");
  });

  it("names the providers the way the team talks about them", () => {
    expect(providerLabel("claude")).toBe("Claude");
    expect(providerLabel("codex")).toBe("GPT / Codex");
    expect(providerLabel("opencode")).toBe("OpenCode");
  });
});

describe("providers in the table", () => {
  const listed = new Set(BOTS.map((bot) => bot.botId));
  const costs = (costUsd: number, unpricedTokens = 0) => ({ costUsd, unpricedTokens });
  const costed = (botId: string, t: PersonalBotTokenUsageTotals, cost: ReturnType<typeof costs>) =>
    ({ botId, totals: t, models: [], sessions: 1, ...cost }) as never;
  const providerRow = (
    provider: "claude" | "codex" | "opencode",
    t: PersonalBotTokenUsageTotals,
    cost: ReturnType<typeof costs>,
  ) => ({ provider, totals: t, ...cost, sessions: 1 });

  const window = (): PersonalBotTokenUsageWindow => ({
    ...windowOf(
      [
        costed("cto", totals(0, 0, 0, 600), costs(6)),
        costed("qa", totals(0, 0, 0, 300), costs(0, 300)),
      ],
      totals(0, 0, 0, 100),
    ),
    providers: [
      // Deliberately out of order: the table sorts.
      providerRow("opencode", totals(0, 0, 0, 100), costs(0, 100)),
      providerRow("claude", totals(0, 0, 0, 600), costs(6)),
      providerRow("codex", totals(0, 0, 0, 300), costs(0, 300)),
    ],
    other: { totals: totals(0, 0, 0, 100), ...costs(0, 100), sessions: 1 },
    total: { totals: totals(0, 0, 0, 1000), ...costs(6, 400), sessions: 3 },
  });

  it("lists providers most tokens first, with their share of everything counted", () => {
    const table = buildTokenUsageTable({ window: window(), bots: BOTS, listedBotIds: listed });
    expect(table.providers.map((p) => [p.label, p.tokens, p.sharePercent])).toEqual([
      ["Claude", 600, 60],
      ["GPT / Codex", 300, 30],
      ["OpenCode", 100, 10],
    ]);
  });

  it("adds up to the table's total, the same figure the bot rows and Outside Bots make", () => {
    const table = buildTokenUsageTable({ window: window(), bots: BOTS, listedBotIds: listed });
    const providerSum = table.providers.reduce((n, p) => n + p.tokens, 0);
    expect(providerSum).toBe(table.total);
    expect(table.botsTotal + table.other.tokens).toBe(table.total);
  });

  it("shows each provider's estimate, a model with no rate as not priced, and the total as partly priced", () => {
    const table = buildTokenUsageTable({ window: window(), bots: BOTS, listedBotIds: listed });
    expect(table.providers.map((p) => formatCostFull(p.cost))).toEqual([
      "$6.00",
      "not priced",
      "not priced",
    ]);
    expect(formatCostFull(table.totalCost)).toBe("$6.00 + unpriced");
    expect(formatCostCompact(table.rows[0]!.cost)).toBe("$6.00");
    expect(formatCostCompact(table.rows[1]!.cost)).toBe("not priced");
    // A listed bot with no use has no estimate to show.
    expect(table.rows.at(-1)!.cost).toEqual({ kind: "none" });
    expect(formatCostCompact(table.other.cost)).toBe("not priced");
  });

  it("folds a removed bot's estimate into Outside Bots with its tokens", () => {
    const table = buildTokenUsageTable({
      window: {
        ...window(),
        rows: [
          costed("cto", totals(0, 0, 0, 600), costs(6)),
          costed("removed", totals(0, 0, 0, 50), costs(2.5)),
        ],
        other: { totals: totals(0, 0, 0, 100), ...costs(1), sessions: 1 },
      },
      bots: BOTS,
      listedBotIds: listed,
    });
    expect(table.other.tokens).toBe(150);
    expect(table.other.cost).toEqual({ kind: "priced", usd: 3.5 });
  });

  it("has no provider rows from a server that sends none, and no cost either", () => {
    const old = windowOf([row("cto", totals(0, 0, 0, 600))]);
    const bare = { ...old, providers: undefined } as never;
    const table = buildTokenUsageTable({ window: bare, bots: BOTS, listedBotIds: listed });
    expect(table.providers).toEqual([]);
    expect(table.rows[0]!.cost).toEqual({ kind: "none" });
  });

  it("reads a provider and a priced bot to a screen reader with the estimate in words", () => {
    const table = buildTokenUsageTable({ window: window(), bots: BOTS, listedBotIds: listed });
    expect(tokenUsageProviderLabel(table.providers[0]!)).toBe(
      "Claude: 600 tokens, 60% of all use, estimated cost $6.00.",
    );
    expect(tokenUsageProviderLabel(table.providers[1]!)).toContain("estimated cost not priced");
    expect(tokenUsageBotButtonLabel(table.rows[0]!)).toBe(
      "CTO, 600 tokens, 67% of bots, $6.00. Show models",
    );
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
    expect(formatSplit(split)).toBe("in 50 · cached 800 (94%) · out 25");
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

  it("gives each row its share of what the bots used, Outside Bots left out", () => {
    const table = buildTokenUsageTable({
      window: windowOf(
        [row("cto", totals(0, 0, 0, 750)), row("qa", totals(0, 0, 0, 250))],
        totals(0, 0, 0, 9000),
      ),
      bots: BOTS,
      listedBotIds: new Set(),
    });
    expect(table.rows.map((r) => r.sharePercent)).toEqual([75, 25]);
    expect(table.botsTotal).toBe(1000);
    expect(table.other.tokens).toBe(9000);
    // The grand total still counts everything.
    expect(table.total).toBe(10_000);
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

  it("counts a bot this screen cannot open under Outside Bots, so the rows still add up", () => {
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
    expect(rowsTotal).toBe(table.botsTotal);
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
    expect(table.other.tokens).toBe(0);
    expect(table.botsTotal).toBe(0);
  });

  it("keeps the window's days for the hint line", () => {
    const table = buildTokenUsageTable({ window: windowOf([]), bots: BOTS, listedBotIds: listed });
    expect(table.sinceDay).toBe("2026-09-28");
    expect(table.untilDay).toBe("2026-10-04");
  });

  it("splits a bot's total into its provider+model lines, each with its own tokens and price", () => {
    const table = buildTokenUsageTable({
      window: windowOf([
        row("cto", totals(0, 0, 0, 1000), 1, [
          model("deepseek", "deepseek-flash", totals(0, 0, 0, 800), 12.02),
          model("claude", "claude-sonnet-5-5", totals(0, 0, 0, 200), 50),
        ]),
      ]),
      bots: BOTS,
      listedBotIds: new Set(),
      modelNames: new Map([
        ["deepseek-flash", "DeepSeek V4.1 Flash"],
        ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
      ]),
    });
    expect(table.rows[0]!.models.map((entry) => [entry.label, entry.tokens])).toEqual([
      ["DeepSeek · V4.1 Flash", 800],
      ["Claude · Sonnet 5.5", 200],
    ]);
    expect(formatCostCompact(table.rows[0]!.models[0]!.cost)).toBe("$12.02");
    expect(table.rows[0]!.models[0]!.sharePercent).toBe(80);
  });

  it("keeps the same model id apart when two providers ran it", () => {
    const table = buildTokenUsageTable({
      window: windowOf([
        row("cto", totals(0, 0, 0, 1000), 1, [
          model("claude", "claude-opus-5-5", totals(0, 0, 0, 600), 30),
          model("opencode", "claude-opus-5-5", totals(0, 0, 0, 400), 1),
        ]),
      ]),
      bots: BOTS,
      listedBotIds: new Set(),
      modelNames: new Map([["claude-opus-5-5", "Claude Opus 5.5"]]),
    });
    expect(table.rows[0]!.models.map((entry) => [entry.provider, entry.tokens])).toEqual([
      ["claude", 600],
      ["opencode", 400],
    ]);
  });

  it("normalises brand casing and names an unresolved Unknown model", () => {
    expect(normalizeModelName("Deepseek V4.1 Flash")).toBe("DeepSeek V4.1 Flash");
    expect(normalizeModelName("DeepSeek V4.1 Flash")).toBe("DeepSeek V4.1 Flash");
    expect(normalizeModelName("Unknown")).toBe("Unknown model");
    expect(normalizeModelName("antigravity-unknown")).toBe("Unknown model");
    expect(normalizeModelName("Antigravity Unknown")).toBe("Unknown model");
    expect(normalizeModelName(" Opus 5.5 ")).toBe("Opus 5.5");
    // Only a name that ends in the word is the placeholder.
    expect(normalizeModelName("Gemini 3.8 Flash N")).toBe("Gemini 3.8 Flash N");
    expect(normalizeModelName("Unknown Things 2")).toBe("Unknown Things 2");

    const table = buildTokenUsageTable({
      window: windowOf([
        row("cto", totals(0, 0, 0, 300), 1, [
          model("opencode", "deepseek-v4.1-flash", totals(0, 0, 0, 200), 2),
          model("antigravity", "antigravity-unknown", totals(0, 0, 0, 100), 0, 100),
          model("codex", "gpt-6.1-sol", totals(0, 0, 0, 50), 1),
        ]),
      ]),
      bots: BOTS,
      listedBotIds: new Set(),
      modelNames: new Map([["deepseek-v4.1-flash", "Deepseek V4.1 Flash"]]),
    });
    expect(table.rows[0]!.models.map((entry) => entry.label)).toEqual([
      "OpenCode · DeepSeek V4.1 Flash",
      "Antigravity · Unknown model",
      "Codex · GPT-6.1-Sol",
    ]);
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

  it("names the days a window covers for the card header", () => {
    expect(formatWindowSpan("2026-10-25", "2026-10-25")).toBe("25 Oct");
    expect(formatWindowSpan("2026-10-19", "2026-10-25")).toBe("19–25 Oct");
    expect(formatWindowSpan("2026-09-26", "2026-10-25")).toBe("26 Sep – 25 Oct");
    expect(formatWindowSpan("2026-10-28", "2026-11-03")).toBe("28 Oct – 3 Nov");
  });

  it("reads a bot row to a screen reader as the button it is", () => {
    const table = buildTokenUsageTable({
      window: windowOf([row("cto", totals(10, 800, 40, 25))]),
      bots: BOTS,
      listedBotIds: new Set(),
    });
    expect(tokenUsageBotButtonLabel(table.rows[0]!)).toBe(
      "CTO, 875 tokens, 100% of bots. Show models",
    );
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

describe("the data behind the mix bars and the bot sheet", () => {
  const listed = new Set(BOTS.map((bot) => bot.botId));
  const priced = (
    provider: UsageProviderKind,
    id: string,
    t: PersonalBotTokenUsageTotals,
    costUsd: number,
    unpricedTokens = 0,
  ) => model(provider, id, t, costUsd, unpricedTokens);

  // What a payload looks like once the server has applied the Antigravity rule
  // (its Claude and GPT routes are counted nowhere): the provider rows, the
  // bots' models and the totals all agree. Claude 8,600 (7,000 CTO + 1,600
  // outside), OpenCode 2,200, Codex 600, Antigravity 50 = 11,450.
  const fixture = (): PersonalBotTokenUsageWindow => {
    const ctoModels = [
      priced("claude", "claude-opus-5-5", totals(100, 6000, 400, 500), 40),
      priced("opencode", "deepseek-v4.1-flash", totals(50, 2000, 0, 150), 2),
      priced("antigravity", "gemini-3.8-flash-lite-preview", totals(10, 0, 0, 40), 0, 50),
    ];
    const qaModels = [priced("codex", "gpt-6.1-sol", totals(20, 500, 0, 80), 3)];
    const cto = totals(160, 8000, 400, 690);
    const qa = totals(20, 500, 0, 80);
    const outside = totals(30, 1500, 0, 70);
    const providerRow = (provider: UsageProviderKind, t: PersonalBotTokenUsageTotals) => ({
      provider,
      totals: t,
      costUsd: 0,
      unpricedTokens: 0,
      sessions: 1,
    });
    return {
      id: "week",
      sinceDay: "2026-10-19",
      untilDay: "2026-10-25",
      rows: [
        {
          botId: "cto",
          totals: cto,
          models: ctoModels,
          sessions: 64,
          costUsd: 42,
          unpricedTokens: 50,
        },
        { botId: "qa", totals: qa, models: qaModels, sessions: 2, costUsd: 3, unpricedTokens: 0 },
      ],
      providers: [
        providerRow("claude", sum(totals(100, 6000, 400, 500), outside)),
        providerRow("opencode", totals(50, 2000, 0, 150)),
        providerRow("codex", qa),
        providerRow("antigravity", totals(10, 0, 0, 40)),
      ],
      other: { totals: outside, costUsd: 1, unpricedTokens: 0, sessions: 4 },
      total: { totals: sum(cto, qa, outside), costUsd: 46, unpricedTokens: 50, sessions: 70 },
    } as unknown as PersonalBotTokenUsageWindow;
  };

  const build = () =>
    buildTokenUsageTable({
      window: fixture(),
      bots: BOTS,
      listedBotIds: listed,
      modelNames: new Map([["claude-opus-5-5", "Claude Opus 5.5"]]),
    });

  it("gives every model its split, and the three parts add up to the model's tokens", () => {
    const table = build();
    const cto = table.rows.find((r) => r.botId === "cto")!;
    for (const entry of cto.models) {
      expect(entry.split.input + entry.split.cached + entry.split.output).toBe(entry.tokens);
    }
    expect(cto.models[0]!.split).toEqual({ input: 500, cached: 6000, output: 500 });
    expect(formatSplit(cto.models[0]!.split)).toBe("in 500 · cached 6.0k (92%) · out 500");
  });

  it("makes each bot's mix out of its models, in the provider order of the card", () => {
    const table = build();
    expect(table.providers.map((p) => p.provider)).toEqual([
      "claude",
      "opencode",
      "codex",
      "antigravity",
    ]);
    const cto = table.rows.find((r) => r.botId === "cto")!;
    expect(cto.mix.map((s) => [s.provider, s.tokens])).toEqual([
      ["claude", 7000],
      ["opencode", 2200],
      ["antigravity", 50],
    ]);
    // A provider the bot did not use is skipped; the others keep their order.
    const qa = table.rows.find((r) => r.botId === "qa")!;
    expect(qa.mix.map((s) => s.provider)).toEqual(["codex"]);
  });

  it("reconciles: a bot's mix and models add up to its total, providers add up to the grand total", () => {
    const table = build();
    for (const entry of table.rows.filter((r) => r.tokens > 0)) {
      expect(entry.mix.reduce((n, s) => n + s.tokens, 0)).toBe(entry.tokens);
      expect(entry.models.reduce((n, m) => n + m.tokens, 0)).toBe(entry.tokens);
    }
    expect(table.total).toBe(11_450);
    expect(table.providers.reduce((n, p) => n + p.tokens, 0)).toBe(table.total);
    expect(table.botsTotal + table.other.tokens).toBe(table.total);
    // Whatever the providers counted beyond the bots is Outside Bots, to the token.
    expect(table.other.mix.reduce((n, s) => n + s.tokens, 0)).toBeCloseTo(table.other.tokens, 6);
    expect(table.other.mix.map((s) => s.provider)).toEqual(["claude"]);
  });

  it("scales Outside Bots' mix to its own tokens when the derived parts disagree", () => {
    const table = buildTokenUsageTable({
      window: {
        ...fixture(),
        // The server says Outside Bots used 1,000; the providers' leftovers are 1,600.
        other: { totals: totals(0, 0, 0, 1000), costUsd: 0, unpricedTokens: 0, sessions: 1 },
      },
      bots: BOTS,
      listedBotIds: listed,
    });
    expect(table.other.mix.reduce((n, s) => n + s.tokens, 0)).toBeCloseTo(1000, 6);
  });

  it("has no Outside mix when there is nothing outside, or nothing to derive it from", () => {
    const none = buildTokenUsageTable({
      window: windowOf([row("cto", totals(0, 0, 0, 10))]),
      bots: BOTS,
      listedBotIds: listed,
    });
    expect(none.other.mix).toEqual([]);
  });

  it("lists the idle bots by name for the one-line fold, and nothing when everyone used tokens", () => {
    const table = build();
    expect(table.idleBotNames).toEqual(["Backend", "Designer", "Watcher"]);
    expect(formatIdleBots(table.idleBotNames)).toBe("No use: Backend, Designer, Watcher");
    const everyone = buildTokenUsageTable({
      window: fixture(),
      bots: BOTS.filter((bot) => bot.botId === "cto" || bot.botId === "qa"),
      listedBotIds: listed,
    });
    expect(everyone.idleBotNames).toEqual([]);
  });

  it("counts the tokens with no price on the row, for the sheet's tile", () => {
    const table = build();
    const cto = table.rows.find((r) => r.botId === "cto")!;
    expect(cto.unpricedTokens).toBe(50);
    expect(cto.cost).toEqual({ kind: "partial", usd: 42 });
    expect(table.rows.find((r) => r.botId === "qa")!.unpricedTokens).toBe(0);
  });

  it("says how many models and how big a share on the bot's row", () => {
    const table = build();
    expect(formatModelsAndShare(table.rows[0]!)).toBe("3 models · 94%");
    expect(formatModelsAndShare(table.rows[1]!)).toBe("1 model · 6%");
  });

  it("shows the session count because the data has it, and drops a part that is zero", () => {
    const table = build();
    expect(table.rows[0]!.sessions).toBe(64);
    expect(formatBotMeta(table.rows[0]!)).toBe("64 sessions · 3 models · 3 providers");
    expect(formatBotMeta(table.rows[1]!)).toBe("2 sessions · 1 model · 1 provider");
    expect(formatBotMeta({ ...table.rows[1]!, sessions: 0 })).toBe("1 model · 1 provider");
  });

  it("sizes a bot's bar against the heaviest bot, never under 2% and never over 100%", () => {
    expect(barWidthPercent(1000, 1000)).toBe(100);
    expect(barWidthPercent(500, 1000)).toBe(50);
    expect(barWidthPercent(1, 1000)).toBe(2);
    expect(barWidthPercent(2000, 1000)).toBe(100);
    expect(barWidthPercent(0, 1000)).toBe(0);
    expect(barWidthPercent(10, 0)).toBe(0);
  });

  it("gives four providers a hue and folds the rest into one grey", () => {
    expect(providerColor("claude")).toBe("var(--personal-provider-claude)");
    expect(providerColor("opencode")).toBe("var(--personal-provider-opencode)");
    expect(providerColor("antigravity")).toBe("var(--personal-provider-antigravity)");
    expect(providerColor("codex")).toBe("var(--personal-provider-codex)");
    for (const provider of ["deepseek", "cursor", "grok"] as const) {
      expect(providerColor(provider)).toBe("var(--personal-provider-other)");
    }
  });
});
