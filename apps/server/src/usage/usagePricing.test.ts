import { describe, expect, it } from "@effect/vitest";

import { cursorRateModel } from "./cursorUsageReader.ts";
import type { UsageSpeed } from "./usageTranscripts.ts";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  GEMINI_38_FLASH_RATES,
  GEMINI_4_ARGON_RATES,
  isDeepSeekPeakTime,
  lookupRate,
  normalizeGeminiModel,
  parseRateTable,
  priceUsage,
} from "./usagePricing.ts";

const rate = (input: number, cacheRead?: number) => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }),
});

/** Wednesday 2026-10-14 12:00 UTC: a weekday outside every peak window. */
const OFF_PEAK_MS = Date.parse("2026-10-14T12:00:00Z");

describe("usage pricing", () => {
  const totals = {
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 500_000,
  };
  const record = (
    model: string,
    reportedCostUsd: number | null = null,
    speed: UsageSpeed = "standard",
  ) => ({
    provider: "claude" as const,
    model,
    timestampMs: OFF_PEAK_MS,
    totals,
    reportedCostUsd,
    speed,
  });

  it("uses custom token rates ahead of public and provider-reported costs", () => {
    const table = parseRateTable({ "example-model": rate(1) });
    const overrides = createOverrideRateTable({
      "example-model": {
        inputCostPerMillionTokens: 2,
        outputCostPerMillionTokens: 8,
        cacheReadCostPerMillionTokens: 0.5,
        cacheWriteCostPerMillionTokens: 3,
      },
    });

    for (const reportedCostUsd of [null, 99]) {
      expect(priceUsage(table, record("example-model", reportedCostUsd), overrides)).toEqual({
        costUsd: 13.5,
        costSource: "modelPriced",
      });
    }
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(1.5);
  });

  it("prices Cursor cache savings at the base model rate", () => {
    const table = parseRateTable({
      "claude-fable-5-1": rate(10e-6, 1e-6),
      "xai/grok-4.7": rate(2e-6, 0.5e-6),
      "openrouter/x-ai/grok-4.7": rate(3e-6, 0.5e-6),
    });
    const cursorRecord = (model: string) => ({
      ...record(model, 0.25),
      rateModel: cursorRateModel(model),
    });

    expect(cacheSavingsUsd(table, cursorRecord("claude-fable-5-1-thinking-high"))).toBeCloseTo(9);
    expect(cacheSavingsUsd(table, cursorRecord("cursor-grok-4.7-high-fast"))).toBeCloseTo(1.5);
    expect(cacheSavingsUsd(table, cursorRecord("default"))).toBe(0);
    expect(priceUsage(table, cursorRecord("grok-4.7-xhigh-fast"))).toEqual({
      costUsd: 0.25,
      costSource: "providerReported",
    });
  });

  it("prices every DeepSeek turn at the published Flash rates, cache split or not", () => {
    const deepseekRecord = (overrides: Partial<typeof totals> = {}) => ({
      provider: "deepseek" as const,
      model: "deepseek-flash",
      timestampMs: OFF_PEAK_MS,
      totals: { ...totals, ...overrides },
      reportedCostUsd: null,
      speed: "standard" as const,
    });

    // A cache split at off-peak: cached input at the cache-hit rate
    // ($0.003/M), the rest at the cache-miss ($0.15/M) and output ($0.60/M)
    // rates. DeepSeek publishes no separate cache-write price, so writes bill
    // as misses.
    const split = priceUsage(new Map(), deepseekRecord());
    expect(split.costSource).toBe("modelPriced");
    expect(split.costUsd).toBeCloseTo(0.15 + 0.003 + 0.15 + 0.6, 10);
    expect(cacheSavingsUsd(new Map(), deepseekRecord())).toBeCloseTo(0.15 - 0.003, 10);

    // No cache split (no cached tokens recorded): every input token at the
    // cache-miss rate.
    const noSplit = priceUsage(
      new Map(),
      deepseekRecord({ cachedInputTokens: 0, cacheCreationTokens: 0 }),
    );
    expect(noSplit.costUsd).toBeCloseTo(0.15 + 0.6, 10);
    expect(cacheSavingsUsd(new Map(), deepseekRecord({ cachedInputTokens: 0 }))).toBe(0);

    // DeepSeek never reads the LiteLLM table: a table that knows its model
    // string, a table that does not, and no table at all price identically.
    const known = parseRateTable({ "deepseek-flash": rate(1) });
    expect(priceUsage(known, deepseekRecord()).costUsd).toBeCloseTo(split.costUsd, 10);
  });

  it("doubles DeepSeek's Flash rates inside the peak windows, priced by record timestamp", () => {
    const deepseekRecord = (timestampMs: number) => ({
      provider: "deepseek" as const,
      model: "deepseek-flash",
      timestampMs,
      totals,
      reportedCostUsd: null,
      speed: "standard" as const,
    });

    // Peak is 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday; every boundary
    // instant: 01:00 and 06:00 enter peak, 04:00 and 10:00 leave it.
    const cases: ReadonlyArray<[number, boolean]> = [
      [Date.parse("2026-10-14T00:59:59.999Z"), false],
      [Date.parse("2026-10-14T01:00:00Z"), true],
      [Date.parse("2026-10-14T03:59:59.999Z"), true],
      [Date.parse("2026-10-14T04:00:00Z"), false],
      [Date.parse("2026-10-14T05:59:59.999Z"), false],
      [Date.parse("2026-10-14T06:00:00Z"), true],
      [Date.parse("2026-10-14T09:59:59.999Z"), true],
      [Date.parse("2026-10-14T10:00:00Z"), false],
      [OFF_PEAK_MS, false],
      // Weekends are off-peak in full.
      [Date.parse("2026-10-17T02:00:00Z"), false],
      [Date.parse("2026-10-18T08:00:00Z"), false],
    ];
    for (const [timestampMs, isPeak] of cases) {
      expect(isDeepSeekPeakTime(timestampMs)).toBe(isPeak);
    }

    const offPeak = deepseekRecord(OFF_PEAK_MS);
    const peak = deepseekRecord(Date.parse("2026-10-14T06:00:00Z"));
    expect(priceUsage(new Map(), peak).costUsd).toBeCloseTo(
      priceUsage(new Map(), offPeak).costUsd * 2,
      10,
    );
    expect(cacheSavingsUsd(new Map(), peak)).toBeCloseTo(
      cacheSavingsUsd(new Map(), offPeak) * 2,
      10,
    );
  });

  it("prices unknown models offline and uses input prices for omitted cache rates", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
    });

    expect(priceUsage(table, record("example-model"), overrides)).toEqual({
      costUsd: 14,
      costSource: "modelPriced",
    });
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(0);
  });

  it("preserves explicit zero rates and matches only the exact trimmed model ID", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      " vendor/example-model[1m] ": {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      },
    });
    expect(priceUsage(table, record(" vendor/example-model[1m] ", 99), overrides)).toEqual({
      costUsd: 0,
      costSource: "modelPriced",
    });
    for (const model of [
      "example-model[1m]",
      "vendor/example-model",
      "vendor/Example-model[1m]",
      "other/example-model[1m]",
    ]) {
      expect(priceUsage(table, record(model), overrides).costSource).toBe("unpriced");
      expect(priceUsage(table, record(model, 99), overrides)).toEqual({
        costUsd: 99,
        costSource: "providerReported",
      });
    }
  });

  it("prices fast-mode requests at the model's published fast multiple", () => {
    const table = parseRateTable({
      "claude-opus-5-5": { ...rate(4e-6, 2e-7), provider_specific_entry: { fast: 2, us: 1.1 } },
      "claude-fable-5-1": { ...rate(1e-5, 2.5e-7), provider_specific_entry: { us: 1.1 } },
    });
    const overrides = createOverrideRateTable({
      "claude-opus-5-5": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 20 },
    });
    const cost = (model: string, speed: UsageSpeed, custom?: typeof overrides) =>
      priceUsage(table, record(model, null, speed), custom).costUsd;

    expect(cost("claude-opus-5-5", "fast")).toBeCloseTo(2 * cost("claude-opus-5-5", "standard"));
    expect(cacheSavingsUsd(table, record("claude-opus-5-5", null, "fast"))).toBeCloseTo(
      2 * cacheSavingsUsd(table, record("claude-opus-5-5")),
    );
    // No published fast tier, and custom prices, both stay at the standard rate.
    expect(cost("claude-fable-5-1", "fast")).toBe(cost("claude-fable-5-1", "standard"));
    expect(cost("claude-opus-5-5", "fast", overrides)).toBe(
      cost("claude-opus-5-5", "standard", overrides),
    );
  });

  it("prices Codex priority and ultrafast requests at their published tier rates", () => {
    const table = parseRateTable({
      "gpt-6-astra": {
        ...rate(1e-5, 1e-6),
        input_cost_per_token_priority: 2e-5,
        output_cost_per_token_priority: 1e-4,
        cache_read_input_token_cost_priority: 2e-6,
        input_cost_per_token_ultrafast: 6e-5,
        output_cost_per_token_ultrafast: 3e-4,
        // No ultrafast cache rate: keeps the standard 10:1 input-to-cache ratio.
      },
      "gpt-6-sol": rate(2e-6, 2e-7),
    });
    const cost = (model: string, speed: UsageSpeed) =>
      priceUsage(table, record(model, null, speed)).costUsd;
    const standard = cost("gpt-6-astra", "standard");

    expect(cost("gpt-6-astra", "fast")).toBeCloseTo(2 * standard);
    expect(cost("gpt-6-astra", "ultrafast")).toBeCloseTo(6 * standard);
    expect(cacheSavingsUsd(table, record("gpt-6-astra", null, "ultrafast"))).toBeCloseTo(
      6 * cacheSavingsUsd(table, record("gpt-6-astra")),
    );
    // A tier the model does not publish bills at the standard rate.
    expect(cost("gpt-6-sol", "ultrafast")).toBe(cost("gpt-6-sol", "standard"));
  });

  it("keeps the canonical Fable rate separate from DeepInfra in either order", () => {
    const canonical = ["claude-fable-5", rate(1e-5, 1e-6)] as const;
    const deepInfra = ["deepinfra/anthropic/claude-fable-5", rate(1e-5)] as const;

    for (const entries of [
      [canonical, deepInfra],
      [deepInfra, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));

      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      expect(lookupRate(table, "other/claude-fable-5")).toBeNull();
    }
  });

  it("prices a bracketed context-tier variant at the base model's rate", () => {
    const table = parseRateTable({ "claude-fable-5-1": rate(1e-5, 2.5e-7) });

    expect(lookupRate(table, "claude-fable-5-1[1m]")).toEqual(
      lookupRate(table, "claude-fable-5-1"),
    );
    expect(lookupRate(table, "anthropic/Claude-Fable-5-1[1m]")).toBeNull();
  });

  it("adds a bare alias when every qualified entry has the same rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("leaves an ambiguous bare name unpriced", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(3),
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("normalizes and prices Gemini models at published rates", () => {
    expect(normalizeGeminiModel("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModel("gemini-3.8-flash-medium")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModel("gemini-3.8-flash-low")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModel("gemini-3.8-flash-n")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModel("gemini-4-argon-high")).toBe("gemini-4-argon");

    const emptyTable = new Map();
    expect(lookupRate(emptyTable, "gemini-3.8-flash")).toEqual(GEMINI_38_FLASH_RATES);
    expect(lookupRate(emptyTable, "gemini-3.8-flash-high")).toEqual(GEMINI_38_FLASH_RATES);
    expect(lookupRate(emptyTable, "gemini-3.8-flash-n")).toEqual(GEMINI_38_FLASH_RATES);
    expect(lookupRate(emptyTable, "gemini-4-argon")).toEqual(GEMINI_4_ARGON_RATES);
    expect(lookupRate(emptyTable, "gemini-4-argon-high")).toEqual(GEMINI_4_ARGON_RATES);
    expect(lookupRate(emptyTable, "antigravity-unknown")).toBeNull();

    const agyRecord = (model: string, overrides: Partial<typeof totals> = {}) => ({
      provider: "antigravity" as const,
      model,
      rateModel: normalizeGeminiModel(model),
      timestampMs: OFF_PEAK_MS,
      totals: { ...totals, ...overrides },
      reportedCostUsd: null,
      speed: "standard" as const,
    });

    const flashPrice = priceUsage(emptyTable, agyRecord("gemini-3.8-flash-high"));
    expect(flashPrice.costSource).toBe("modelPriced");
    expect(flashPrice.costUsd).toBeCloseTo(0.75 + 0.075 + 0.75 + 3.75, 10);
    expect(cacheSavingsUsd(emptyTable, agyRecord("gemini-3.8-flash-high"))).toBeCloseTo(
      0.75 - 0.075,
      10,
    );

    const argonPrice = priceUsage(emptyTable, agyRecord("gemini-4-argon"));
    expect(argonPrice.costSource).toBe("modelPriced");
    expect(argonPrice.costUsd).toBeCloseTo(2.0 + 0.1 + 2.0 + 10.0, 10);
  });
});
