// @effect-diagnostics globalDate:off
/**
 * Pure rules for the per-bot Token usage table: which bot a transcript session
 * belongs to, and how the day cells fold into the Today, 7 days and 30 days
 * windows. No I/O, so it is tested without a database or a transcript.
 *
 * A bot's chats are provider sessions. The session id each chat resumes lives
 * in `provider_session_runtime.resume_cursor_json` (Claude: `resume`, Codex:
 * `threadId`, OpenCode: `sessionId`), and the chat belongs to a bot through
 * `personal_bot_threads`. A transcript session no live chat points to (a
 * deleted chat, work done outside the app) lands in "other".
 *
 * @module botTokenUsage
 */
import type {
  PersonalBotTokenUsageModel,
  PersonalBotTokenUsageProviderRow,
  PersonalBotTokenUsageRow,
  PersonalBotTokenUsageSum,
  PersonalBotTokenUsageTotals,
  PersonalBotTokenUsageWindow,
  PersonalBotTokenUsageWindowId,
  UsageProviderKind,
} from "@t3tools/contracts";
import { PersonalBotId } from "@t3tools/contracts";

import { botUsageTotalTokens, type BotUsageCell } from "../usage/botUsage.ts";

/** Days the largest window spans, today included. */
export const TOKEN_USAGE_MONTH_DAYS = 30;
const TOKEN_USAGE_WEEK_DAYS = 7;

const SYNTHETIC_MODEL = "<synthetic>";

/** Models listed per bot. */
const MAX_MODELS_PER_ROW = 5;

/** A chat's provider session, as the database stores it. */
export interface ChatSessionRow {
  readonly botId: string;
  /** `provider_session_runtime.provider_name`. */
  readonly providerName: string;
  /** `provider_session_runtime.resume_cursor_json`. */
  readonly resumeCursorJson: string | null;
}

function usageProviderOf(providerName: string): UsageProviderKind | null {
  switch (providerName) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

/** The key sessions are matched on: the provider keeps id spaces apart. */
export function sessionKey(provider: UsageProviderKind, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

/** The session id a chat's resume cursor names, or null when it names none. */
export function sessionIdFromResumeCursor(
  provider: UsageProviderKind,
  resumeCursorJson: string | null,
): string | null {
  if (resumeCursorJson === null) return null;
  let cursor: unknown;
  try {
    cursor = JSON.parse(resumeCursorJson);
  } catch {
    return null;
  }
  if (typeof cursor !== "object" || cursor === null) return null;
  const field = provider === "claude" ? "resume" : provider === "codex" ? "threadId" : "sessionId";
  const value = (cursor as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Session to bot, for every chat that has a session id we know how to read. */
export function buildSessionOwners(rows: ReadonlyArray<ChatSessionRow>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of rows) {
    const provider = usageProviderOf(row.providerName);
    if (provider === null) continue;
    const sessionId = sessionIdFromResumeCursor(provider, row.resumeCursorJson);
    if (sessionId === null) continue;
    owners.set(sessionKey(provider, sessionId), row.botId);
  }
  return owners;
}

/** `YYYY-MM-DD` of an instant in `timeZone`; an unknown zone reads as UTC. */
export function dayInZone(timestampMs: number, timeZone: string): string {
  const make = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  let format: Intl.DateTimeFormat;
  try {
    format = make(timeZone);
  } catch {
    format = make("UTC");
  }
  return format.format(new Date(timestampMs));
}

/** The day `delta` days from `day` (calendar arithmetic, so no zone or DST in it). */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, date + delta));
  return shifted.toISOString().slice(0, 10);
}

/** First and last day of each window ending on `today`. */
export function tokenUsageWindowRanges(
  today: string,
): ReadonlyArray<{ id: PersonalBotTokenUsageWindowId; sinceDay: string; untilDay: string }> {
  return [
    { id: "today", sinceDay: today, untilDay: today },
    { id: "week", sinceDay: shiftDay(today, -(TOKEN_USAGE_WEEK_DAYS - 1)), untilDay: today },
    { id: "month", sinceDay: shiftDay(today, -(TOKEN_USAGE_MONTH_DAYS - 1)), untilDay: today },
  ];
}

type MutableTotals = { -readonly [K in keyof PersonalBotTokenUsageTotals]: number };

function emptyTotals(): MutableTotals {
  return { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };
}

function addInto(into: MutableTotals, cell: BotUsageCell["totals"]): void {
  into.uncachedInputTokens += cell.uncachedInputTokens;
  into.cachedInputTokens += cell.cachedInputTokens;
  into.cacheCreationTokens += cell.cacheCreationTokens;
  into.outputTokens += cell.outputTokens;
}

interface Accumulator {
  readonly totals: MutableTotals;
  readonly models: Map<string, number>;
  readonly sessions: Set<string>;
  costUsd: number;
  unpricedTokens: number;
}

function newAccumulator(): Accumulator {
  return {
    totals: emptyTotals(),
    models: new Map(),
    sessions: new Set(),
    costUsd: 0,
    unpricedTokens: 0,
  };
}

/**
 * Folds the day cells into the three windows.
 *
 * `activeBotIds` are the bots that still exist; a session owned by any other
 * bot (removed since) is "other", as is one with no owner or no session id.
 * Every counted token is in exactly one of the rows or `other`, so `total` is
 * their sum.
 */
export function computeTokenUsageWindows(input: {
  readonly cells: ReadonlyArray<BotUsageCell>;
  readonly owners: ReadonlyMap<string, string>;
  readonly activeBotIds: ReadonlySet<string>;
  readonly today: string;
}): ReadonlyArray<PersonalBotTokenUsageWindow> {
  return tokenUsageWindowRanges(input.today).map((range) => {
    const perBot = new Map<string, Accumulator>();
    const perProvider = new Map<UsageProviderKind, Accumulator>();
    const other = newAccumulator();
    const total = newAccumulator();

    for (const cell of input.cells) {
      if (cell.day < range.sinceDay || cell.day > range.untilDay) continue;
      const key = cell.sessionId.length === 0 ? null : sessionKey(cell.provider, cell.sessionId);
      const owner = key === null ? undefined : input.owners.get(key);
      const botId = owner !== undefined && input.activeBotIds.has(owner) ? owner : null;

      let target: Accumulator;
      if (botId === null) {
        target = other;
      } else {
        let existing = perBot.get(botId);
        if (existing === undefined) {
          existing = newAccumulator();
          perBot.set(botId, existing);
        }
        target = existing;
      }
      let provider = perProvider.get(cell.provider);
      if (provider === undefined) {
        provider = newAccumulator();
        perProvider.set(cell.provider, provider);
      }
      const tokens = botUsageTotalTokens(cell.totals);
      for (const accumulator of [target, total, provider]) {
        addInto(accumulator.totals, cell.totals);
        accumulator.costUsd += cell.costUsd;
        accumulator.unpricedTokens += cell.unpricedTokens;
        accumulator.models.set(cell.model, (accumulator.models.get(cell.model) ?? 0) + tokens);
        if (key !== null) accumulator.sessions.add(key);
      }
    }

    const rows: PersonalBotTokenUsageRow[] = [];
    for (const [botId, accumulator] of perBot) {
      rows.push({
        botId: PersonalBotId.make(botId),
        totals: accumulator.totals,
        costUsd: accumulator.costUsd,
        unpricedTokens: accumulator.unpricedTokens,
        models: topModels(accumulator.models),
        sessions: accumulator.sessions.size,
      });
    }
    // Biggest first, so the payload reads in the order the table shows it.
    rows.sort(
      (a, b) => rowTokens(b) - rowTokens(a) || String(a.botId).localeCompare(String(b.botId)),
    );

    const providers: PersonalBotTokenUsageProviderRow[] = [...perProvider].map(
      ([provider, accumulator]) => ({
        provider,
        totals: accumulator.totals,
        costUsd: accumulator.costUsd,
        unpricedTokens: accumulator.unpricedTokens,
        sessions: accumulator.sessions.size,
      }),
    );
    providers.sort(
      (a, b) =>
        botUsageTotalTokens(b.totals) - botUsageTotalTokens(a.totals) ||
        a.provider.localeCompare(b.provider),
    );

    return {
      id: range.id,
      sinceDay: range.sinceDay,
      untilDay: range.untilDay,
      rows,
      providers,
      other: toSum(other),
      total: toSum(total),
    };
  });
}

function rowTokens(row: PersonalBotTokenUsageRow): number {
  return botUsageTotalTokens(row.totals);
}

function toSum(accumulator: Accumulator): PersonalBotTokenUsageSum {
  return {
    totals: accumulator.totals,
    costUsd: accumulator.costUsd,
    unpricedTokens: accumulator.unpricedTokens,
    sessions: accumulator.sessions.size,
  };
}

function topModels(models: ReadonlyMap<string, number>): PersonalBotTokenUsageModel[] {
  return (
    [...models]
      // Claude writes "<synthetic>" for the stub replies it makes itself (no model ran).
      .filter(([model]) => model !== SYNTHETIC_MODEL)
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_MODELS_PER_ROW)
      .map(([model, totalTokens]) => ({ model, totalTokens }))
  );
}
