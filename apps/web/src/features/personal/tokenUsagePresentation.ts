import type {
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageStatus,
  PersonalBotTokenUsageTotals,
  PersonalBotTokenUsageWindow,
  PersonalBotTokenUsageWindowId,
} from "@t3tools/contracts";

/**
 * The Token usage table on the Team screen, as plain data: windows, rows
 * ranked by use, the numbers as short labels, and the freshness line. Pure, so
 * the ranking and the wording are tested without a screen.
 */

export const TOKEN_USAGE_WINDOWS: ReadonlyArray<{
  readonly id: PersonalBotTokenUsageWindowId;
  readonly label: string;
}> = [
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
];

export const DEFAULT_TOKEN_USAGE_WINDOW: PersonalBotTokenUsageWindowId = "week";

/** Bots with a rank chip: the heaviest users. */
export const TOKEN_USAGE_TOP_COUNT = 3;

const UNITS: ReadonlyArray<{ readonly suffix: string; readonly size: number }> = [
  { suffix: "k", size: 1e3 },
  { suffix: "M", size: 1e6 },
  { suffix: "B", size: 1e9 },
];

/**
 * A token count as a short label: `842`, `12.3k`, `120.4M`, `1.2B`. One decimal
 * past a thousand, so columns of them stay the same width; a value that rounds
 * up to the next unit moves to it (`999.96k` is `1.0M`, never `1000.0k`).
 */
export function formatTokenCount(count: number): string {
  const value = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  if (value < 1000) return String(value);
  let unitIndex = UNITS.findLastIndex((unit) => value >= unit.size);
  let scaled = value / UNITS[unitIndex]!.size;
  if (Number(scaled.toFixed(1)) >= 1000 && unitIndex < UNITS.length - 1) {
    unitIndex += 1;
    scaled = value / UNITS[unitIndex]!.size;
  }
  return `${scaled.toFixed(1)}${UNITS[unitIndex]!.suffix}`;
}

/** `42%`, `<1%` for a share that is real but under one percent, `0%` for none. */
export function formatShare(percent: number): string {
  if (!(percent > 0)) return "0%";
  if (percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/** Everything the headline counts: all input (cached and cache writes too) plus output. */
export function totalOf(totals: PersonalBotTokenUsageTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/** The headline split into the three parts a reader can tell apart. They add up to the total. */
export interface TokenSplit {
  /** New input: uncached input plus cache writes. */
  readonly input: number;
  /** Input served from the cache. */
  readonly cached: number;
  readonly output: number;
}

export function splitOf(totals: PersonalBotTokenUsageTotals): TokenSplit {
  return {
    input: totals.uncachedInputTokens + totals.cacheCreationTokens,
    cached: totals.cachedInputTokens,
    output: totals.outputTokens,
  };
}

/** `in 4.2M · cached 110.0M · out 1.2M` */
export function formatSplit(split: TokenSplit): string {
  return `in ${formatTokenCount(split.input)} · cached ${formatTokenCount(split.cached)} · out ${formatTokenCount(split.output)}`;
}

export interface TokenUsageBot {
  readonly botId: string;
  readonly name: string;
}

export interface TokenUsageRowView {
  readonly botId: string;
  readonly name: string;
  readonly tokens: number;
  /** Share of what the bots used in the window (Outside Bots left out), 0 to 100. */
  readonly sharePercent: number;
  /** 1 to 3 for the heaviest users, else null. A bot with no use has no rank. */
  readonly rank: 1 | 2 | 3 | null;
  readonly split: TokenSplit;
  readonly sessions: number;
}

export interface TokenUsageTable {
  readonly rows: ReadonlyArray<TokenUsageRowView>;
  /**
   * Outside Bots: tokens of sessions no bot owns (the owner's own Claude Code,
   * older and deleted sessions), plus any bot this screen does not list.
   */
  readonly other: { readonly tokens: number };
  /** What the listed bots used. Rows' shares and bars are over this. */
  readonly botsTotal: number;
  /** Everything counted: the bots plus Outside Bots. */
  readonly total: number;
  readonly sinceDay: string;
  readonly untilDay: string;
}

const EMPTY_TOTALS: PersonalBotTokenUsageTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
};

function share(tokens: number, total: number): number {
  return total > 0 ? (tokens / total) * 100 : 0;
}

/**
 * The table for one window. `bots` is every bot the screen can open (a bot
 * with use always has a row); `listedBotIds` are the ones that get a row even
 * with no use, so the table reads as the whole team. Rows run from most to
 * least tokens, ties by name. Shares are of the bots' own total, so the owner's
 * work outside the bots (Outside Bots) does not shrink them. A bot with use
 * that is not in `bots` (it was removed since the scan) is counted under
 * Outside Bots, so the rows and Outside Bots still add up to the total.
 */
export function buildTokenUsageTable(input: {
  readonly window: PersonalBotTokenUsageWindow;
  readonly bots: ReadonlyArray<TokenUsageBot>;
  readonly listedBotIds: ReadonlySet<string>;
}): TokenUsageTable {
  const { window } = input;
  const byId = new Map(input.bots.map((bot) => [bot.botId, bot]));
  const total = totalOf(window.total.totals);

  const used = new Map<
    string,
    { tokens: number; totals: PersonalBotTokenUsageTotals; sessions: number }
  >();
  let otherTokens = totalOf(window.other.totals);
  for (const row of window.rows) {
    const tokens = totalOf(row.totals);
    if (tokens === 0) continue;
    if (byId.has(row.botId)) {
      used.set(row.botId, { tokens, totals: row.totals, sessions: row.sessions });
    } else {
      otherTokens += tokens;
    }
  }

  const botsTotal = [...used.values()].reduce((sum, entry) => sum + entry.tokens, 0);
  const ids = new Set<string>(used.keys());
  for (const botId of input.listedBotIds) if (byId.has(botId)) ids.add(botId);

  const unranked = [...ids].map((botId) => {
    const bot = byId.get(botId)!;
    const entry = used.get(botId);
    return {
      botId,
      name: bot.name,
      tokens: entry?.tokens ?? 0,
      totals: entry?.totals ?? EMPTY_TOTALS,
      sessions: entry?.sessions ?? 0,
    };
  });
  unranked.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  const rows = unranked.map((entry, index): TokenUsageRowView => {
    const rank =
      entry.tokens > 0 && index < TOKEN_USAGE_TOP_COUNT ? ((index + 1) as 1 | 2 | 3) : null;
    return {
      botId: entry.botId,
      name: entry.name,
      tokens: entry.tokens,
      sharePercent: share(entry.tokens, botsTotal),
      rank,
      split: splitOf(entry.totals),
      sessions: entry.sessions,
    };
  });

  return {
    rows,
    other: { tokens: otherTokens },
    botsTotal,
    total,
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
  };
}

/** The window named `id`, or null while the server has not sent windows yet. */
export function findTokenUsageWindow(
  result: PersonalBotTokenUsageResult | null,
  id: PersonalBotTokenUsageWindowId,
): PersonalBotTokenUsageWindow | null {
  return result?.windows.find((window) => window.id === id) ?? null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `Updated just now`, `Updated 4m ago`, `Updated 2h ago`, `Updated 3d ago`. */
export function formatUpdated(readAt: string | null, nowMs: number): string | null {
  if (readAt === null) return null;
  const at = Date.parse(readAt);
  if (!Number.isFinite(at)) return null;
  const elapsed = Math.max(0, nowMs - at);
  if (elapsed < MINUTE_MS) return "Updated just now";
  if (elapsed < HOUR_MS) return `Updated ${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `Updated ${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `Updated ${Math.floor(elapsed / DAY_MS)}d ago`;
}

/** A read the server is still working on: ask again soon rather than wait for the next interval. */
export function isTokenUsagePending(status: PersonalBotTokenUsageStatus | undefined): boolean {
  return status === "warming" || status === "refreshing";
}

/** Gap before asking again while the server counts. The first count after a restart takes up to a minute. */
export const TOKEN_USAGE_POLL_MS = 4_000;

/** Stops polling a count that never lands; the ten-minute refresh takes over. */
export const TOKEN_USAGE_MAX_POLLS = 30;

/** What the row reads as to a screen reader: the visible parts, in the order they are read. */
export function tokenUsageRowLabel(row: TokenUsageRowView): string {
  if (row.tokens === 0) return `${row.name}: no tokens used. Open ${row.name}.`;
  const rank = row.rank === null ? "" : `Number ${row.rank} user. `;
  return `${row.name}: ${formatTokenCount(row.tokens)} tokens, ${formatShare(row.sharePercent)} of the bots' use. ${rank}${formatSplit(row.split)}. Open ${row.name}.`;
}

/** `5 Sep to 4 Oct`, or `4 Oct` for a single day: what the window covers, for the hint line. */
export function formatWindowRange(sinceDay: string, untilDay: string): string {
  const label = (day: string) => {
    const [, month, date] = day.split("-").map(Number);
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return `${date} ${months[(month ?? 1) - 1] ?? ""}`;
  };
  return sinceDay === untilDay ? label(untilDay) : `${label(sinceDay)} to ${label(untilDay)}`;
}
