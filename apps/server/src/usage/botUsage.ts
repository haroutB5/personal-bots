// @effect-diagnostics globalDate:off
/**
 * Folds parsed transcript records into `(day, session, provider, model)` cells
 * for the per-bot Token usage table.
 *
 * It sees the same records as the usage page's `UsageAggregator` and drops
 * repeats the same way (a dedupe key is counted once across every file), but
 * keeps the session the usage page throws away, so the caller can attribute
 * a session to a bot. It carries no prices and no cost.
 *
 * Pure and cheap per record: the scan feeds it hundreds of thousands of
 * records on a cold start and the loop around it yields between slices, so
 * nothing here may be slower than a few microseconds. The wall-clock day is
 * resolved once per minute (`Intl` is the slow part), which is exact because
 * no zone changes its offset inside a minute.
 *
 * @module botUsage
 */
import type { UsageProviderKind } from "@t3tools/contracts";

import { priceUsageCost, type RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

/** The four buckets the usage page shows. Reasoning is inside output. */
export interface BotUsageTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

export interface BotUsageCell {
  readonly day: string;
  readonly provider: UsageProviderKind;
  readonly model: string;
  /** Empty when the transcript line carried no session id. */
  readonly sessionId: string;
  readonly totals: BotUsageTotals;
  readonly records: number;
  /**
   * API price estimate of the priced records, USD: LiteLLM list rates (cached
   * input at the cached rate), a custom price override, or the provider's own
   * reported cost. Records with no rate add nothing here, only to
   * `unpricedTokens`.
   */
  readonly costUsd: number;
  /** Tokens (all four buckets) of records no rate or reported cost covers. */
  readonly unpricedTokens: number;
}

const MINUTE_MS = 60_000;

/** `YYYY-MM-DD` of an instant in `timeZone`; an unknown zone degrades to UTC. */
function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
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
  const byMinute = new Map<number, string>();
  return (timestampMs) => {
    const minute = Math.floor(timestampMs / MINUTE_MS);
    let day = byMinute.get(minute);
    if (day === undefined) {
      day = format.format(new Date(minute * MINUTE_MS));
      byMinute.set(minute, day);
    }
    return day;
  };
}

export interface BotUsageAggregatorOptions {
  readonly timeZone: string;
  /** First and last day to keep, `YYYY-MM-DD` in `timeZone`, both inclusive. */
  readonly sinceDay: string;
  readonly untilDay: string;
  /** LiteLLM rates. Without them no record is priced (all of it is `unpricedTokens`). */
  readonly rates?: RateTable;
  /** Custom prices from settings, applied before the table. */
  readonly priceOverrides?: RateTable;
}

/** What one transcript file feeds in; see {@link UsageBotAggregator.beginFile}. */
export interface BotUsageFileScope {
  /** Folds one record in. True when it counted. */
  add: (record: UsageRecord) => boolean;
}

export class UsageBotAggregator {
  readonly #cells = new Map<string, MutableCell>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #sinceDay: string;
  readonly #untilDay: string;
  readonly #minPossibleMs: number;
  readonly #maxPossibleMs: number;
  readonly #rates: RateTable;
  readonly #priceOverrides: RateTable | undefined;
  #lastDay = "";
  #lastSessionId = "";
  #lastProvider: UsageProviderKind | "" = "";
  #lastModel = "";
  #lastCell: MutableCell | undefined;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: BotUsageAggregatorOptions) {
    this.#toDay = makeDayFormatter(options.timeZone);
    this.#sinceDay = options.sinceDay;
    this.#untilDay = options.untilDay;
    // Generous +/-26h UTC guard covers every IANA timezone (-12..+14) without calling Intl.
    const sinceUtc = Date.parse(`${options.sinceDay}T00:00:00Z`);
    const untilUtc = Date.parse(`${options.untilDay}T00:00:00Z`);
    this.#minPossibleMs = Number.isFinite(sinceUtc)
      ? sinceUtc - 26 * 3_600_000
      : Number.NEGATIVE_INFINITY;
    this.#maxPossibleMs = Number.isFinite(untilUtc)
      ? untilUtc + 50 * 3_600_000
      : Number.POSITIVE_INFINITY;
    this.#rates = options.rates ?? new Map();
    this.#priceOverrides =
      options.priceOverrides !== undefined && options.priceOverrides.size > 0
        ? options.priceOverrides
        : undefined;
  }

  get duplicatesDropped(): number {
    return this.#duplicatesDropped;
  }

  get outOfWindow(): number {
    return this.#outOfWindow;
  }

  /**
   * One file's worth of records. Codex rollouts carry no unique id per event, so
   * a moved copy of a rollout is matched by its content, with a per-file
   * occurrence counter so two equal events inside one rollout both count (their
   * timestamps can have only second precision). Same rule as the usage page.
   */
  beginFile(): BotUsageFileScope {
    let occurrences: Map<string, number> | undefined;
    return {
      add: (record) => {
        let dedupeKey = record.dedupeKey;
        if (record.provider === "codex" && record.sessionId.length > 0) {
          occurrences ??= new Map<string, number>();
          const content = codexContentKey(record);
          const occurrence = (occurrences.get(content) ?? 0) + 1;
          occurrences.set(content, occurrence);
          dedupeKey = `${content}:${occurrence}`;
        }
        return this.#add(record, dedupeKey);
      },
    };
  }

  /** Folds one record in on its own, with its own dedupe key (no Codex occurrence handling). */
  add(record: UsageRecord): boolean {
    return this.#add(record, record.dedupeKey);
  }

  #add(record: UsageRecord, dedupeKey: string | null): boolean {
    if (dedupeKey !== null) {
      if (this.#seen.has(dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(dedupeKey);
    }

    const ts = record.timestampMs;
    if (ts < this.#minPossibleMs || ts > this.#maxPossibleMs) {
      this.#outOfWindow += 1;
      return false;
    }

    const day = this.#toDay(ts);
    if (day < this.#sinceDay || day > this.#untilDay) {
      this.#outOfWindow += 1;
      return false;
    }

    let cell = this.#lastCell;
    if (
      cell === undefined ||
      day !== this.#lastDay ||
      record.sessionId !== this.#lastSessionId ||
      record.provider !== this.#lastProvider ||
      record.model !== this.#lastModel
    ) {
      const key = `${day}\u0000${record.sessionId}\u0000${record.provider}\u0000${record.model}`;
      cell = this.#cells.get(key);
      if (cell === undefined) {
        cell = {
          day,
          provider: record.provider,
          model: record.model,
          sessionId: record.sessionId,
          totals: {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
          },
          records: 0,
          costUsd: 0,
          unpricedTokens: 0,
        };
        this.#cells.set(key, cell);
      }
      this.#lastDay = day;
      this.#lastSessionId = record.sessionId;
      this.#lastProvider = record.provider;
      this.#lastModel = record.model;
      this.#lastCell = cell;
    }
    const totals = record.totals;
    cell.totals.uncachedInputTokens += totals.uncachedInputTokens;
    cell.totals.cachedInputTokens += totals.cachedInputTokens;
    cell.totals.cacheCreationTokens += totals.cacheCreationTokens;
    cell.totals.outputTokens += totals.outputTokens;
    cell.records += 1;
    // Priced per record, because speed and reported cost can differ inside one cell.
    const costUsd = priceUsageCost(this.#rates, record, this.#priceOverrides);
    if (costUsd === null) {
      cell.unpricedTokens += botUsageTotalTokens(totals);
    } else {
      cell.costUsd += costUsd;
    }
    return true;
  }

  finish(): readonly BotUsageCell[] {
    return [...this.#cells.values()].toSorted(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );
  }
}

interface MutableCell {
  readonly day: string;
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: BotUsageTotals;
  records: number;
  costUsd: number;
  unpricedTokens: number;
}

function codexContentKey(record: UsageRecord): string {
  const totals = record.totals;
  return `${record.sessionId}\u0000${record.timestampMs}\u0000${record.model}\u0000${totals.uncachedInputTokens}\u0000${totals.cachedInputTokens}\u0000${totals.cacheCreationTokens}\u0000${totals.outputTokens}\u0000${totals.reasoningTokens}`;
}

/** The sum of a cell's four buckets: the headline figure (all input plus output). */
export function botUsageTotalTokens(totals: BotUsageTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}
