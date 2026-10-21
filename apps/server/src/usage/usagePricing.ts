/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against. Everything here is pure: fetching and caching
 * the table lives in `UsageService`.
 *
 * @module usagePricing
 */
import type { UsageCostSource, UsageModelPriceOverride } from "@t3tools/contracts";
import { deepSeekPeakWindowEndMs } from "@t3tools/shared/deepseekPeak";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { UsageRecord, UsageSpeed } from "./usageTranscripts.ts";

/** Token rates for one billing speed. All values are USD per token. */
export interface TokenRates {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

/**
 * The subset of a LiteLLM entry we price against: standard rates, plus rates
 * for each faster speed the model publishes. A request at a speed with no
 * published rates bills at the standard rates.
 *
 * LiteLLM also publishes `*_above_272k_tokens`, `*_flex`, and `*_batches`
 * variants. Transcripts don't record those, so we don't price them.
 */
export interface ModelRate extends TokenRates {
  /**
   * From LiteLLM's `provider_specific_entry.fast` multiple (Claude fast mode),
   * or else its `*_priority` rates (Codex `priority`).
   */
  readonly fast: TokenRates | null;
  /** From LiteLLM's `*_ultrafast` rates (Codex `ultrafast`). */
  readonly ultrafast: TokenRates | null;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/**
 * DeepSeek-V4-Flash off-peak rates, USD per token, from DeepSeek's published
 * card (retrieved 2026-10-11; off-peak is half of peak).
 *
 * DeepSeek bills through its own rate card, not the LiteLLM table the other
 * providers price against, and the picker offers only Flash, so every DeepSeek
 * record prices as Flash regardless of the model string a transcript carries.
 * DeepSeek publishes no separate cache-write rate, so cache writes bill as
 * cache misses.
 */
export const DEEPSEEK_FLASH_RATES: ModelRate = {
  inputCostPerToken: 0.15 / 1_000_000,
  outputCostPerToken: 0.6 / 1_000_000,
  cacheReadCostPerToken: 0.003 / 1_000_000,
  cacheCreationCostPerToken: 0.15 / 1_000_000,
  fast: null,
  ultrafast: null,
};

/** The same card at peak: exactly double the off-peak rates. */
export const DEEPSEEK_FLASH_PEAK_RATES: ModelRate = {
  inputCostPerToken: 0.3 / 1_000_000,
  outputCostPerToken: 1.2 / 1_000_000,
  cacheReadCostPerToken: 0.006 / 1_000_000,
  cacheCreationCostPerToken: 0.3 / 1_000_000,
  fast: null,
  ultrafast: null,
};

/**
 * Gemini-3.8-Flash published list rates, USD per token.
 * Retrieved 2026-10-21 from Google's published Gemini API price list:
 * https://ai.google.dev/pricing
 * https://ai.google.dev/gemini-api/docs/pricing
 */
export const GEMINI_38_FLASH_RATES: ModelRate = {
  inputCostPerToken: 0.75 / 1_000_000,
  outputCostPerToken: 3.75 / 1_000_000,
  cacheReadCostPerToken: 0.075 / 1_000_000,
  cacheCreationCostPerToken: 0.75 / 1_000_000,
  fast: null,
  ultrafast: null,
};

/**
 * Gemini-4-Argon published list rates, USD per token.
 * Retrieved 2026-10-21 from Google's published Gemini API price list:
 * https://ai.google.dev/pricing
 * https://ai.google.dev/gemini-api/docs/pricing
 */
export const GEMINI_4_ARGON_RATES: ModelRate = {
  inputCostPerToken: 2.0 / 1_000_000,
  outputCostPerToken: 10.0 / 1_000_000,
  cacheReadCostPerToken: 0.1 / 1_000_000,
  cacheCreationCostPerToken: 2.0 / 1_000_000,
  fast: null,
  ultrafast: null,
};

const GEMINI_PUBLISHED_RATES: Readonly<Record<string, ModelRate>> = {
  "gemini-3.8-flash": GEMINI_38_FLASH_RATES,
  "gemini-4-argon": GEMINI_4_ARGON_RATES,
};

/**
 * Normalizes Gemini model names to match the published rate card by stripping
 * effort/tier suffixes (e.g. `-high`, `-medium`, `-low`, `-n`).
 */
export function normalizeGeminiModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/(?:-(?:high|medium|low|none|minimal|xhigh|max|n))$/, "");
}

/**
 * Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday.
 * Everything else — weekends included — is off-peak. Chinese public holidays
 * are off-peak in full as well; this ignores them, so their peak-hour records
 * price half too high rather than too low.
 */
const fastDeepSeekPricing = process.env.T3CODE_DEEPSEEK_PRICING_FAST !== "off";

export function isDeepSeekPeakTime(timestampMs: number): boolean {
  if (fastDeepSeekPricing) {
    return deepSeekPeakWindowEndMs(timestampMs) !== null;
  }
  // A millisecond input makes a UTC DateTime; its parts are UTC. An
  // unreadable timestamp prices as off-peak rather than throwing mid-scan.
  const at = DateTime.make(timestampMs);
  if (Option.isNone(at)) return false;
  const parts = DateTime.toParts(at.value);
  const utcDay = parts.weekDay; // 0 Sunday .. 6 Saturday
  if (utcDay === 0 || utcDay === 6) return false;
  const utcHour = parts.hour;
  return (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
}

/**
 * Custom IDs keep their case, provider prefix, and variant suffix. Custom rates
 * apply as entered, at every speed.
 */
export function createOverrideRateTable(
  overrides: Readonly<Record<string, UsageModelPriceOverride>>,
): RateTable {
  return new Map(
    Object.entries(overrides).map(([model, prices]) => [
      model.trim(),
      {
        inputCostPerToken: prices.inputCostPerMillionTokens / 1_000_000,
        outputCostPerToken: prices.outputCostPerMillionTokens / 1_000_000,
        cacheReadCostPerToken:
          (prices.cacheReadCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000,
        cacheCreationCostPerToken:
          (prices.cacheWriteCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000,
        fast: null,
        ultrafast: null,
      },
    ]),
  );
}

/** One raw LiteLLM entry. Field names carry a tier suffix, e.g. `_priority`. */
type LiteLlmEntry = Readonly<Record<string, unknown>>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads one rate set, `suffix` selecting a tier such as `_priority`. Returns
 * `null` without both an input and an output rate.
 *
 * Anthropic bills cache reads at a discount and cache writes at a premium.
 * When the standard tier omits them, cached input is priced as plain input
 * rather than as free. A faster tier that omits them keeps the standard tier's
 * cache-to-input ratio.
 */
function readTokenRates(
  entry: LiteLlmEntry,
  suffix: string,
  standard?: TokenRates,
): TokenRates | null {
  const input = finiteNumber(entry[`input_cost_per_token${suffix}`]);
  const output = finiteNumber(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  const cacheRate = (name: string, field: "cacheReadCostPerToken" | "cacheCreationCostPerToken") =>
    finiteNumber(entry[`${name}${suffix}`]) ??
    (standard !== undefined && standard.inputCostPerToken > 0
      ? (standard[field] / standard.inputCostPerToken) * input
      : input);
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken: cacheRate(
      "cache_creation_input_token_cost",
      "cacheCreationCostPerToken",
    ),
  };
}

function scaleTokenRates(rates: TokenRates, multiple: number): TokenRates {
  return {
    inputCostPerToken: rates.inputCostPerToken * multiple,
    outputCostPerToken: rates.outputCostPerToken * multiple,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * multiple,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * multiple,
  };
}

/** Reads `provider_specific_entry.fast`, e.g. `2` for Claude Opus 5.5. */
function fastMultiplier(entry: LiteLlmEntry): number | null {
  const specific = entry["provider_specific_entry"];
  if (typeof specific !== "object" || specific === null) return null;
  const fast = finiteNumber((specific as Record<string, unknown>)["fast"]);
  return fast !== null && fast > 0 ? fast : null;
}

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced.
 *
 * Entries keep their full normalized key; a bare name is aliased only when no
 * canonical entry exists and every qualified entry has the same rate.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const standard = readTokenRates(entry, "");
    if (standard === null) continue;

    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    const multiple = fastMultiplier(entry);
    table.set(key, {
      ...standard,
      fast:
        multiple === null
          ? readTokenRates(entry, "_priority", standard)
          : scaleTokenRates(standard, multiple),
      ultrafast: readTokenRates(entry, "_ultrafast", standard),
    });
  }

  // `null` marks a bare name claimed at conflicting rates: no alias for it.
  const aliasCandidates = new Map<string, ModelRate | null>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const held = aliasCandidates.get(alias);
    if (held === undefined) {
      aliasCandidates.set(alias, rate);
    } else if (held !== null && !sameRate(held, rate)) {
      aliasCandidates.set(alias, null);
    }
  }
  for (const [alias, rate] of aliasCandidates) {
    if (rate !== null) table.set(alias, rate);
  }

  return table;
}

function sameTokenRates(a: TokenRates | null, b: TokenRates | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken
  );
}

function sameRate(a: ModelRate, b: ModelRate): boolean {
  return (
    sameTokenRates(a, b) &&
    sameTokenRates(a.fast, b.fast) &&
    sameTokenRates(a.ultrafast, b.ultrafast)
  );
}

/** The rates a request at `speed` bills at. */
function ratesAt(rate: ModelRate, speed: UsageSpeed): TokenRates {
  return (speed === "standard" ? null : rate[speed]) ?? rate;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Drops a bracketed variant suffix such as `claude-fable-5-1[1m]`, which
 * Claude Code writes for the 1M context tier. The rate table only knows the
 * base name, and we price at the base tier anyway.
 */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

/**
 * Models we never price, regardless of the table.
 *
 * `<synthetic>` marks locally generated messages that were never billed. Bare
 * family names ("opus", "sonnet") are genuinely ambiguous across generations,
 * so we report them as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;
  const fromTable = table.get(key);
  if (fromTable !== undefined) return fromTable;
  const normalizedGemini = normalizeGeminiModel(bareName);
  return GEMINI_PUBLISHED_RATES[normalizedGemini] ?? null;
}

/** The parts of a transcript record that decide its price. */
export type PricedRecord = Pick<
  UsageRecord,
  "provider" | "model" | "rateModel" | "totals" | "speed" | "reportedCostUsd" | "timestampMs"
>;

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

/**
 * The rate a record prices at, before overrides: DeepSeek's own published card
 * (provider-keyed, so it never depends on the transcript's model string and
 * works with no rate table fetched) — peak or off-peak by the record's own
 * timestamp — else the LiteLLM table by model name.
 */
function baseRate(table: RateTable, record: PricedRecord): ModelRate | null {
  if (record.provider === "deepseek") {
    return isDeepSeekPeakTime(record.timestampMs)
      ? DEEPSEEK_FLASH_PEAK_RATES
      : DEEPSEEK_FLASH_RATES;
  }
  return lookupRate(table, record.rateModel ?? record.model);
}

/**
 * Prices one record's tokens.
 *
 * `reasoningTokens` is intentionally not charged separately: it is already
 * counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): PricedUsage {
  const { model, totals, reportedCostUsd } = record;
  const override = overrides?.get(model.trim());
  if (override === undefined && reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }

  const rate = override ?? baseRate(table, record);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };

  const rates = ratesAt(rate, record.speed);
  return {
    costUsd:
      totals.uncachedInputTokens * rates.inputCostPerToken +
      totals.cachedInputTokens * rates.cacheReadCostPerToken +
      totals.cacheCreationTokens * rates.cacheCreationCostPerToken +
      totals.outputTokens * rates.outputCostPerToken,
    costSource: "modelPriced",
  };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): number {
  const rate = overrides?.get(record.model.trim()) ?? baseRate(table, record);
  if (rate === null) return 0;
  const rates = ratesAt(rate, record.speed);
  return record.totals.cachedInputTokens * (rates.inputCostPerToken - rates.cacheReadCostPerToken);
}
