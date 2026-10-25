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
import { sessionIdFromResumeCursor, usageProviderOf } from "../usage/providerSessions.ts";

export { sessionIdFromResumeCursor, usageProviderOf };

/** Days the largest window spans, today included. */
export const TOKEN_USAGE_MONTH_DAYS = 30;
const TOKEN_USAGE_WEEK_DAYS = 7;

const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Antigravity can route a call to a Claude or a GPT model. Harout's rule
 * (21 Oct): those tokens are not shown in usage stats, and the same tokens are
 * counted nowhere either (every total, provider row, bot row and share), so
 * every number on the card adds up. Gemini and an Antigravity row with no
 * model id stay counted. Matches a whole word, so only a model named Claude or
 * GPT-something is dropped.
 */
const ROUTED_CLAUDE_OR_GPT = /(?:^|[^a-z])(?:claude|gpt)(?:[^a-z]|$)/i;

export function isHiddenAntigravityModel(provider: UsageProviderKind, model: string): boolean {
  return provider === "antigravity" && ROUTED_CLAUDE_OR_GPT.test(model);
}

/** A chat's provider session, as the database stores it. */
export interface ChatSessionRow {
  readonly botId: string;
  /** `provider_session_runtime.provider_name`. */
  readonly providerName: string;
  /** `provider_session_runtime.resume_cursor_json`. */
  readonly resumeCursorJson: string | null;
  /** `provider_session_history.session_id`: a session this chat used earlier. */
  readonly sessionId?: string | null;
}

/** The key sessions are matched on: the provider keeps id spaces apart. */
export function sessionKey(provider: UsageProviderKind, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

/** Session to bot, for every chat that has a session id we know how to read. */
export function buildSessionOwners(rows: ReadonlyArray<ChatSessionRow>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of rows) {
    const provider = usageProviderOf(row.providerName);
    if (provider === null) continue;
    // A history row names an earlier session; a runtime row names the current
    // one. A row that carries both (as a test fixture may) maps both.
    const sessionIds = [
      row.sessionId ?? null,
      sessionIdFromResumeCursor(provider, row.resumeCursorJson),
    ];
    for (const sessionId of sessionIds) {
      if (sessionId === null) continue;
      owners.set(sessionKey(provider, sessionId), row.botId);
    }
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

interface ModelAccumulator {
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly totals: MutableTotals;
  costUsd: number;
  unpricedTokens: number;
}

interface Accumulator {
  readonly totals: MutableTotals;
  readonly models: Map<string, ModelAccumulator>;
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
 * their sum. Antigravity's Claude and GPT routes are not counted at all (see
 * `isHiddenAntigravityModel`), so the provider rows add up to `total` too.
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
      if (isHiddenAntigravityModel(cell.provider, cell.model)) continue;
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
      for (const accumulator of [target, total, provider]) {
        addInto(accumulator.totals, cell.totals);
        accumulator.costUsd += cell.costUsd;
        accumulator.unpricedTokens += cell.unpricedTokens;
        if (key !== null) accumulator.sessions.add(key);
      }
      if (botId !== null) {
        // A bot's own models are kept apart with their provider and price, so
        // a mixed-provider total never reads as if one model used all of it.
        const modelKey = `${cell.provider}\u0000${cell.model}`;
        let model = target.models.get(modelKey);
        if (model === undefined) {
          model = {
            provider: cell.provider,
            model: cell.model,
            totals: emptyTotals(),
            costUsd: 0,
            unpricedTokens: 0,
          };
          target.models.set(modelKey, model);
        }
        addInto(model.totals, cell.totals);
        model.costUsd += cell.costUsd;
        model.unpricedTokens += cell.unpricedTokens;
      }
    }

    const rows: PersonalBotTokenUsageRow[] = [];
    for (const [botId, accumulator] of perBot) {
      rows.push({
        botId: PersonalBotId.make(botId),
        totals: accumulator.totals,
        costUsd: accumulator.costUsd,
        unpricedTokens: accumulator.unpricedTokens,
        models: modelsOf(accumulator.models),
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

function modelsOf(models: ReadonlyMap<string, ModelAccumulator>): PersonalBotTokenUsageModel[] {
  return (
    [...models.values()]
      // Claude writes "<synthetic>" for the stub replies it makes itself (no model ran).
      .filter((model) => model.model !== SYNTHETIC_MODEL)
      .filter((model) => botUsageTotalTokens(model.totals) > 0)
      .toSorted(
        (a, b) =>
          botUsageTotalTokens(b.totals) - botUsageTotalTokens(a.totals) ||
          a.provider.localeCompare(b.provider) ||
          a.model.localeCompare(b.model),
      )
      .map((model) => ({
        provider: model.provider,
        model: model.model,
        totals: model.totals,
        costUsd: model.costUsd,
        unpricedTokens: model.unpricedTokens,
      }))
  );
}
