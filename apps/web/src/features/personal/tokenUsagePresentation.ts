import type {
  PersonalBotTokenUsageCost,
  PersonalBotTokenUsageModel,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageStatus,
  PersonalBotTokenUsageTotals,
  PersonalBotTokenUsageWindow,
  PersonalBotTokenUsageWindowId,
  UsageProviderKind,
} from "@t3tools/contracts";

import { shortModelName } from "./botModelLabel";

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

/** `in 4.2M · cached 110.0M (96%) · out 1.2M` */
export function formatSplit(split: TokenSplit): string {
  const hit = cacheHitShare(split);
  return `in ${formatTokenCount(split.input)} · cached ${formatTokenCount(split.cached)}${hit === null ? "" : ` (${hit}%)`} · out ${formatTokenCount(split.output)}`;
}

/**
 * The share of input served from the cache, 0-100, or null when nothing was
 * cached. Cheap DeepSeek turns depend on this staying high: only the new part
 * of a prompt is paid at the full input rate.
 */
export function cacheHitShare(split: TokenSplit): number | null {
  const input = split.input + split.cached;
  if (split.cached <= 0 || input <= 0) return null;
  return Math.round((split.cached / input) * 100);
}

/**
 * The API price estimate beside a token count. `partial` is a count where some
 * tokens have a price and some do not; `unpriced` is one where none do; `none`
 * is no tokens at all, or a server that sent no cost.
 */
export type TokenCostView =
  | { readonly kind: "none" }
  | { readonly kind: "unpriced" }
  | { readonly kind: "priced"; readonly usd: number }
  | { readonly kind: "partial"; readonly usd: number };

/**
 * `$0.42`, `<$0.01` for a real but tiny amount, `$12.40`, `$1,234` from a
 * thousand (cents stop mattering), `$12.3k` from ten thousand. Short enough for
 * the 64 px column beside a bot's tokens.
 */
export function formatUsd(usd: number): string {
  const value = Number.isFinite(usd) && usd > 0 ? usd : 0;
  if (value === 0) return "$0.00";
  if (value < 0.005) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  if (value < 10_000) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${(value / 1000).toFixed(1)}k`;
}

/** Cost view for `tokens` tokens of which `cost.unpricedTokens` have no price. */
export function costViewOf(
  tokens: number,
  cost: Partial<PersonalBotTokenUsageCost> | undefined,
): TokenCostView {
  if (tokens <= 0 || cost === undefined) return { kind: "none" };
  const usd = cost.costUsd;
  const unpriced = cost.unpricedTokens;
  if (typeof usd !== "number" || typeof unpriced !== "number") return { kind: "none" };
  if (unpriced >= tokens) return { kind: "unpriced" };
  return unpriced > 0 ? { kind: "partial", usd } : { kind: "priced", usd };
}

/** Short: `$12.40`, `$12.40+` (some tokens unpriced), `not priced`. Empty for none. */
export function formatCostCompact(view: TokenCostView): string {
  switch (view.kind) {
    case "none":
      return "";
    case "unpriced":
      return "not priced";
    case "priced":
      return formatUsd(view.usd);
    case "partial":
      return `${formatUsd(view.usd)}+`;
  }
}

/** Full: `$12.40 + unpriced`. For the places that have the width. */
export function formatCostFull(view: TokenCostView): string {
  return view.kind === "partial" ? `${formatUsd(view.usd)} + unpriced` : formatCostCompact(view);
}

/** For a screen reader: the same figure in words. */
export function costAriaLabel(view: TokenCostView): string {
  switch (view.kind) {
    case "none":
      return "";
    case "unpriced":
      return "estimated cost not priced";
    case "priced":
      return `estimated cost ${formatUsd(view.usd)}`;
    case "partial":
      return `estimated cost ${formatUsd(view.usd)} plus tokens that are not priced`;
  }
}

const PROVIDER_LABELS: Readonly<Record<UsageProviderKind, string>> = {
  claude: "Claude",
  codex: "GPT / Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  antigravity: "Antigravity",
  deepseek: "DeepSeek",
};

export function providerLabel(provider: UsageProviderKind): string {
  return PROVIDER_LABELS[provider];
}

/** The provider's name on a tight per-model line, where "GPT / Codex" would crowd the model. */
const SHORT_PROVIDER_LABELS: Readonly<Record<UsageProviderKind, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
  antigravity: "Antigravity",
  deepseek: "DeepSeek",
};

export function shortProviderLabel(provider: UsageProviderKind): string {
  return SHORT_PROVIDER_LABELS[provider];
}

/**
 * The colour a provider wears wherever usage is drawn: a dot, a bar segment.
 * It follows the provider, never its rank, and is never used for text. Four
 * providers have a hue; any other (DeepSeek direct, Cursor, Grok) folds into
 * one grey rather than inventing a fifth.
 */
const PROVIDER_COLORS: Readonly<Partial<Record<UsageProviderKind, string>>> = {
  claude: "var(--personal-provider-claude)",
  opencode: "var(--personal-provider-opencode)",
  antigravity: "var(--personal-provider-antigravity)",
  codex: "var(--personal-provider-codex)",
};

export function providerColor(provider: UsageProviderKind): string {
  return PROVIDER_COLORS[provider] ?? "var(--personal-provider-other)";
}

/** One provider's part of a bar: how many tokens it carries. */
export interface TokenUsageMixSegment {
  readonly provider: UsageProviderKind;
  readonly tokens: number;
}

export interface TokenUsageProviderView {
  readonly provider: UsageProviderKind;
  readonly label: string;
  readonly tokens: number;
  /** Share of everything counted in the window (Outside Bots included), 0 to 100. */
  readonly sharePercent: number;
  readonly cost: TokenCostView;
  readonly split: TokenSplit;
}

export interface TokenUsageBot {
  readonly botId: string;
  readonly name: string;
}

/** One provider and model a bot used, with what that route alone cost. */
export interface TokenUsageModelView {
  readonly provider: UsageProviderKind;
  /** The provider's short name: "Claude", "Codex", "OpenCode". */
  readonly providerLabel: string;
  /** The model as the picker names it, e.g. "Opus 5.5", "V4.1 Flash". */
  readonly model: string;
  /** The line as drawn: "DeepSeek · V4.1 Flash". */
  readonly label: string;
  readonly tokens: number;
  /** Share of the bot's own tokens, 0 to 100. */
  readonly sharePercent: number;
  readonly cost: TokenCostView;
  /** New input, cached input and output of this route. They add up to `tokens`. */
  readonly split: TokenSplit;
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
  /** Every provider and model the bot used in the window, most tokens first. */
  readonly models: ReadonlyArray<TokenUsageModelView>;
  /** The bot's tokens by provider, in the card's provider order. They add up to the models' tokens. */
  readonly mix: ReadonlyArray<TokenUsageMixSegment>;
  readonly sessions: number;
  readonly cost: TokenCostView;
  /** Tokens of this row with no price, for "1.1M not priced". */
  readonly unpricedTokens: number;
}

export interface TokenUsageTable {
  readonly rows: ReadonlyArray<TokenUsageRowView>;
  /** Tokens by provider, most first. They add up to `total`. */
  readonly providers: ReadonlyArray<TokenUsageProviderView>;
  /** The estimate for everything counted. */
  readonly totalCost: TokenCostView;
  /**
   * Outside Bots: tokens of sessions no bot owns (the owner's own Claude Code,
   * older and deleted sessions), plus any bot this screen does not list.
   */
  readonly other: {
    readonly tokens: number;
    readonly cost: TokenCostView;
    /**
     * Outside Bots by provider: what each provider counted beyond the bots'
     * own models, scaled to `tokens` so the bar is exactly as long as the row.
     */
    readonly mix: ReadonlyArray<TokenUsageMixSegment>;
  };
  /** Names of the listed bots with no use in the window, for the "No use" line. */
  readonly idleBotNames: ReadonlyArray<string>;
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
  /**
   * Model slug to the name the picker shows it by. A model this map does not
   * know keeps its id, so a retired model never disappears from the table.
   */
  readonly modelNames?: ReadonlyMap<string, string>;
}): TokenUsageTable {
  const { window } = input;
  const byId = new Map(input.bots.map((bot) => [bot.botId, bot]));
  const total = totalOf(window.total.totals);

  const used = new Map<
    string,
    {
      tokens: number;
      totals: PersonalBotTokenUsageTotals;
      models: ReadonlyArray<PersonalBotTokenUsageModel>;
      sessions: number;
      cost: Partial<PersonalBotTokenUsageCost>;
    }
  >();
  let otherTokens = totalOf(window.other.totals);
  // A removed bot's use joins Outside Bots, estimate included.
  let otherUsd = window.other.costUsd ?? 0;
  let otherUnpriced = window.other.unpricedTokens ?? 0;
  for (const row of window.rows) {
    const tokens = totalOf(row.totals);
    if (tokens === 0) continue;
    if (byId.has(row.botId)) {
      used.set(row.botId, {
        tokens,
        totals: row.totals,
        models: row.models ?? [],
        sessions: row.sessions,
        cost: row,
      });
    } else {
      otherTokens += tokens;
      otherUsd += row.costUsd ?? 0;
      otherUnpriced += row.unpricedTokens ?? 0;
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
      models: modelViewsOf(entry?.models ?? [], entry?.tokens ?? 0, input.modelNames),
      sessions: entry?.sessions ?? 0,
      cost: costViewOf(entry?.tokens ?? 0, entry?.cost),
      unpricedTokens: entry?.cost.unpricedTokens ?? 0,
    };
  });
  unranked.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  const providers = (window.providers ?? [])
    .map((entry): TokenUsageProviderView => {
      const tokens = totalOf(entry.totals);
      return {
        provider: entry.provider,
        label: providerLabel(entry.provider),
        tokens,
        sharePercent: share(tokens, total),
        cost: costViewOf(tokens, entry),
        split: splitOf(entry.totals),
      };
    })
    .filter((entry) => entry.tokens > 0)
    .toSorted((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
  const providerOrder = providers.map((entry) => entry.provider);

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
      models: entry.models,
      mix: mixOf(entry.models, providerOrder),
      sessions: entry.sessions,
      cost: entry.cost,
      unpricedTokens: entry.unpricedTokens,
    };
  });

  // What each provider counted beyond the listed bots' own models is Outside
  // Bots'. The tokens shown stay `other`; the bar is scaled to match them.
  const botTokensByProvider = new Map<UsageProviderKind, number>();
  for (const row of rows) {
    for (const segment of row.mix) {
      botTokensByProvider.set(
        segment.provider,
        (botTokensByProvider.get(segment.provider) ?? 0) + segment.tokens,
      );
    }
  }
  const derivedOther = providers
    .map((entry) => ({
      provider: entry.provider,
      tokens: Math.max(0, entry.tokens - (botTokensByProvider.get(entry.provider) ?? 0)),
    }))
    .filter((segment) => segment.tokens > 0);
  const derivedOtherTotal = derivedOther.reduce((sum, segment) => sum + segment.tokens, 0);
  const otherMix =
    otherTokens > 0 && derivedOtherTotal > 0
      ? derivedOther.map((segment) => ({
          provider: segment.provider,
          tokens: (segment.tokens / derivedOtherTotal) * otherTokens,
        }))
      : [];

  return {
    rows,
    providers,
    totalCost: costViewOf(total, window.total),
    other: {
      tokens: otherTokens,
      cost: costViewOf(otherTokens, { costUsd: otherUsd, unpricedTokens: otherUnpriced }),
      mix: otherMix,
    },
    idleBotNames: rows.filter((row) => row.tokens === 0).map((row) => row.name),
    botsTotal,
    total,
    sinceDay: window.sinceDay,
    untilDay: window.untilDay,
  };
}

/** A bot's provider+model lines, heaviest first, each with its own price. */
function modelViewsOf(
  models: ReadonlyArray<PersonalBotTokenUsageModel>,
  botTokens: number,
  modelNames: ReadonlyMap<string, string> | undefined,
): ReadonlyArray<TokenUsageModelView> {
  return models
    .map((entry): TokenUsageModelView => {
      const tokens = totalOf(entry.totals);
      const provider = shortProviderLabel(entry.provider);
      const model = modelDisplayName(entry.model, modelNames);
      return {
        provider: entry.provider,
        providerLabel: provider,
        model,
        label: `${provider} · ${withoutProviderPrefix(provider, model)}`,
        tokens,
        sharePercent: share(tokens, botTokens),
        cost: costViewOf(tokens, entry),
        split: splitOf(entry.totals),
      };
    })
    .filter((entry) => entry.tokens > 0)
    .toSorted((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}

/**
 * A bot's tokens by provider, in the card's provider order (the order the
 * legend shows), so a provider keeps its place in every bar. A provider the bot
 * did not use has no segment.
 */
function mixOf(
  models: ReadonlyArray<TokenUsageModelView>,
  providerOrder: ReadonlyArray<UsageProviderKind>,
): ReadonlyArray<TokenUsageMixSegment> {
  const byProvider = new Map<UsageProviderKind, number>();
  for (const model of models) {
    byProvider.set(model.provider, (byProvider.get(model.provider) ?? 0) + model.tokens);
  }
  const ordered = providerOrder.filter((provider) => byProvider.has(provider));
  // A provider the window list lacks (it cannot happen on a real payload) goes last.
  const rest = [...byProvider.keys()].filter((provider) => !providerOrder.includes(provider));
  return [...ordered, ...rest].map((provider) => ({
    provider,
    tokens: byProvider.get(provider) ?? 0,
  }));
}

/**
 * Known brand casing in a model name, and the placeholder name a provider with
 * no model data reports: "Deepseek V4.1 Flash" reads "DeepSeek V4.1 Flash", and
 * a name ending in "Unknown" reads "Unknown model" rather than looking like a
 * bug. Matching the end of the name covers the prefixed forms a real payload
 * sends ("antigravity-unknown", "Antigravity Unknown"), while a real model that
 * only mentions Unknown elsewhere is left alone.
 */
export function normalizeModelName(name: string): string {
  const branded = name.replace(/\bdeepseek\b/gi, "DeepSeek").trim();
  if (/(?:^|[\s\-_/])unknown$/i.test(branded)) return "Unknown model";
  return branded;
}

/**
 * An unresolved GPT route id keeps its hyphens and title case: a Codex
 * provider that is offline still names `gpt-6.1-sol` "GPT-6.1-Sol" rather than
 * "Gpt 6 1 Sol". Null for every other id, which keeps the readable form.
 */
function gptModelName(id: string): string | null {
  const match = /^gpt[-_](.+)$/i.exec(id);
  if (match === null) return null;
  const rest = match[1]!
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("-");
  return rest === "" ? null : `GPT-${rest}`;
}

/**
 * The picker's name for a model id: "claude-opus-5-5" is "Opus 5.5" (the
 * "Claude" the provider name already says is dropped), "deepseek-flash" is
 * "V4.1 Flash". OpenCode ids may be prefixed ("opencode/deepseek-v4.1-flash"),
 * so the last segment is looked up too. An id nobody lists keeps a readable
 * form of itself rather than disappearing.
 */
function modelDisplayName(
  model: string,
  modelNames: ReadonlyMap<string, string> | undefined,
): string {
  if (modelNames !== undefined) {
    const base = model.slice(model.lastIndexOf("/") + 1);
    const listed = modelNames.get(model) ?? modelNames.get(base);
    if (listed !== undefined) {
      const short = shortModelName(listed);
      if (short !== "") return normalizeModelName(short);
    }
  }
  const base = model.slice(model.lastIndexOf("/") + 1);
  const gpt = gptModelName(base);
  if (gpt !== null) return normalizeModelName(gpt);
  return normalizeModelName(
    base
      .replace(/[-_]+/g, " ")
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
      .trim() || model,
  );
}

/** "DeepSeek · V4.1 Flash", not "DeepSeek · DeepSeek V4.1 Flash". */
function withoutProviderPrefix(providerLabel: string, model: string): string {
  const prefix = `${providerLabel} `;
  return model.toLowerCase().startsWith(prefix.toLowerCase())
    ? model.slice(prefix.length).trim() || model
    : model;
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

/** What a provider row reads as to a screen reader. */
export function tokenUsageProviderLabel(row: TokenUsageProviderView): string {
  const cost = costAriaLabel(row.cost);
  return `${row.label}: ${formatTokenCount(row.tokens)} tokens, ${formatShare(row.sharePercent)} of all use${cost === "" ? "" : `, ${cost}`}.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayParts(day: string): { readonly date: number; readonly month: string } {
  const [, month, date] = day.split("-").map(Number);
  return { date: date ?? 0, month: MONTHS[(month ?? 1) - 1] ?? "" };
}

/**
 * What the window covers, for the card header: `25 Oct` for one day, `19–25 Oct`
 * inside a month, `26 Sep – 25 Oct` across two.
 */
export function formatWindowSpan(sinceDay: string, untilDay: string): string {
  const since = dayParts(sinceDay);
  const until = dayParts(untilDay);
  if (sinceDay === untilDay) return `${until.date} ${until.month}`;
  if (since.month === until.month) return `${since.date}–${until.date} ${until.month}`;
  return `${since.date} ${since.month} – ${until.date} ${until.month}`;
}

/** The bot row's middle line: `7 models · 32%`, `1 model · 7%`. */
export function formatModelsAndShare(row: TokenUsageRowView): string {
  const count = row.models.length;
  return `${count} ${count === 1 ? "model" : "models"} · ${formatShare(row.sharePercent)}`;
}

/** The "No use: Astra, QA" line under the bot rows. */
export function formatIdleBots(names: ReadonlyArray<string>): string {
  return `No use: ${names.join(", ")}`;
}

/** The distinct providers a bot used, for "4 providers" and the single-provider note. */
export function providersOf(row: TokenUsageRowView): ReadonlyArray<UsageProviderKind> {
  return row.mix.map((segment) => segment.provider);
}

/** `64 sessions · 7 models · 4 providers`, each part left out when its count is zero. */
export function formatBotMeta(row: TokenUsageRowView): string {
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  const parts = [
    row.sessions > 0 ? plural(row.sessions, "session", "sessions") : null,
    row.models.length > 0 ? plural(row.models.length, "model", "models") : null,
    row.mix.length > 0 ? plural(row.mix.length, "provider", "providers") : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

/** Width of a bot's bar against the heaviest bot, as a 0-100 percentage (at least 2). */
export function barWidthPercent(tokens: number, topTokens: number): number {
  if (tokens <= 0 || topTokens <= 0) return 0;
  return Math.max(2, Math.min(100, (tokens / topTokens) * 100));
}

/** "Frontend, 1.9B tokens, 32% of bots, $183.33+. Show models" */
export function tokenUsageBotButtonLabel(row: TokenUsageRowView): string {
  const cost = formatCostCompact(row.cost);
  return `${row.name}, ${formatTokenCount(row.tokens)} tokens, ${formatShare(row.sharePercent)} of bots${cost === "" ? "" : `, ${cost}`}. Show models`;
}
