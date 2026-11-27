import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import { parseRateTable, priceUsage } from "../../usage/usagePricing.ts";
import { makeEcoTurnState, noteEcoUsage } from "./ecoMode.ts";
import { makeEcoTurnRecorder, priceEcoSide } from "./ecoTurnRecorder.ts";

const side = (model: string, tokens: number) => ({
  model,
  inputTokens: tokens,
  outputTokens: tokens * 2,
  cacheReadTokens: tokens * 10,
  cacheWriteTokens: tokens * 3,
  sdkCostUsd: tokens / 1_000,
  calls: 2,
});

// A flat $1 per million tokens of any kind, so the stored cost is easy to check.
const flatPricer = (record: { readonly model: string; readonly totals: Record<string, number> }) =>
  Effect.succeed(
    record.model === "unknown-model"
      ? { costUsd: 0, costSource: "unpriced" as const, categoryCostUsd: null, speedPremiumUsd: 0 }
      : {
          costUsd:
            (record.totals.uncachedInputTokens! +
              record.totals.cachedInputTokens! +
              record.totals.cacheCreationTokens! +
              record.totals.outputTokens!) /
            1_000_000,
          costSource: "modelPriced" as const,
          categoryCostUsd: null,
          speedPremiumUsd: 0,
        },
  );

it.effect("stores an Eco turn's planner and builder usage and priced cost (migration 165)", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const record = makeEcoTurnRecorder({
      sql: Option.some(sql),
      priceUsage: flatPricer as never,
      newId: () => "eco-1",
    });
    yield* record("bot-1", {
      threadId: "thread-1",
      runId: "run-1",
      status: "completed",
      handedOff: true,
      plan: "## Goal",
      startedAt: new Date(0),
      handedOffAt: new Date(1_000),
      completedAt: new Date(2_000),
      planner: side("claude-opus-5-5", 100),
      builder: side("claude-sonnet-5-5", 1_000),
      other: [],
      calls: [
        { id: "m1", model: "claude-opus-5-5", side: "planner" },
        { id: "m2", model: "claude-sonnet-5-5", side: "builder" },
      ],
    });
    const rows = yield* sql<{
      readonly planner_model: string;
      readonly builder_model: string;
      readonly handed_off: number;
      readonly planner_cache_read_tokens: number;
      readonly builder_cache_write_tokens: number;
      readonly planner_cost_usd: number;
      readonly builder_cost_usd: number;
      readonly calls_json: string;
    }>`SELECT * FROM personal_eco_turns WHERE bot_id = 'bot-1'`;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      planner_model: "claude-opus-5-5",
      builder_model: "claude-sonnet-5-5",
      handed_off: 1,
      planner_cache_read_tokens: 1_000,
      builder_cache_write_tokens: 3_000,
    });
    expect(row.planner_cost_usd).toBeCloseTo(1_600 / 1_000_000, 9);
    expect(row.builder_cost_usd).toBeCloseTo(16_000 / 1_000_000, 9);
    expect(JSON.parse(row.calls_json)).toHaveLength(2);

    // The new bot columns default Eco off.
    const columns = yield* sql<{ readonly name: string; readonly dflt_value: string | null }>`
      SELECT name, dflt_value FROM pragma_table_info('personal_bots')
      WHERE name IN ('eco_enabled', 'eco_model_json') ORDER BY name
    `;
    expect(columns).toEqual([
      { name: "eco_enabled", dflt_value: "0" },
      { name: "eco_model_json", dflt_value: null },
    ]);
  }).pipe(Effect.provide(personalTestDatabase)),
);

it.effect("prices an unpriced model as null and an unused side as zero", () =>
  Effect.gen(function* () {
    expect(yield* priceEcoSide(flatPricer as never, side("unknown-model", 5), 0)).toBe(null);
    expect(yield* priceEcoSide(flatPricer as never, side("claude-opus-5-5", 0), 0)).toBe(0);
    expect(yield* priceEcoSide(undefined, side("claude-opus-5-5", 5), 0)).toBe(null);
  }),
);

// The comparison's rates (LiteLLM), 1-hour cache writes dearer than 5-minute ones.
const rateTable = parseRateTable({
  "claude-opus-5-5": {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 5e-6,
    cache_creation_input_token_cost_above_1hr: 8e-6,
  },
  "claude-sonnet-5-5": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 2.5e-6,
    cache_creation_input_token_cost_above_1hr: 4e-6,
  },
});
const tablePricer = (record: Parameters<typeof priceUsage>[1]) =>
  Effect.succeed(priceUsage(rateTable, record));

it.effect("prices each call from its own usage, with 1-hour cache writes at the 1-hour rate", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const record = makeEcoTurnRecorder({
      sql: Option.some(sql),
      priceUsage: tablePricer as never,
      newId: () => "eco-1h",
    });
    // Claude Code sends one message per content block; the usage keeps the largest counts.
    const turn = makeEcoTurnState({
      runId: "run-1h",
      threadId: "thread-1h",
      models: {
        planner: { instanceId: "claude", model: "claude-opus-5-5" },
        builder: { instanceId: "claude", model: "claude-sonnet-5-5" },
      } as never,
      plannerApiModel: "claude-opus-5-5",
      builderApiModel: "claude-sonnet-5-5",
      startedAt: new Date(0),
    });
    const opusUsage = {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 20_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 },
    };
    noteEcoUsage(turn, "m1", "claude-opus-5-5", opusUsage);
    noteEcoUsage(turn, "m1", "claude-opus-5-5", { ...opusUsage, output_tokens: 500 });
    noteEcoUsage(turn, "m2", "claude-sonnet-5-5", {
      input_tokens: 5,
      output_tokens: 1_000,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 4_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 3_000 },
    });
    // A subagent call on the builder model, with no breakdown: billed as a 5-minute write.
    noteEcoUsage(turn, "m3", "claude-sonnet-5-5", {
      input_tokens: 0,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 2_000,
    });
    noteEcoUsage(turn, "s1", "<synthetic>", { input_tokens: 1 });
    expect([...turn.usage.keys()]).toEqual(["m1", "m2", "m3"]);

    // The summed modelUsage, deliberately wrong, so the test proves it is not used.
    const summed = (model: string) => ({
      model,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      sdkCostUsd: 0,
      calls: 1,
    });
    yield* record("bot-1h", {
      threadId: "thread-1h",
      runId: "run-1h",
      status: "completed",
      handedOff: true,
      startedAt: new Date(0),
      completedAt: new Date(2_000),
      planner: summed("claude-opus-5-5"),
      builder: summed("claude-sonnet-5-5"),
      other: [],
      calls: [
        { id: "m1", model: "claude-opus-5-5", side: "planner" },
        { id: "m2", model: "claude-sonnet-5-5", side: "builder" },
      ],
      callUsage: [...turn.usage.values()],
    });
    const rows = yield* sql<{
      readonly planner_cost_usd: number;
      readonly builder_cost_usd: number;
      readonly planner_cache_write_tokens: number;
      readonly builder_cache_write_tokens: number;
      readonly builder_output_tokens: number;
      readonly calls_json: string;
    }>`SELECT * FROM personal_eco_turns WHERE bot_id = 'bot-1h'`;
    const row = rows[0]!;
    // Opus: 10 in, 500 out, 20k 1-hour writes at $8/M (not the 5-minute $5/M).
    expect(row.planner_cost_usd).toBeCloseTo(10 * 4e-6 + 500 * 2e-5 + 20_000 * 8e-6, 9);
    // Sonnet m2 + m3: 1k 5-minute and 3k 1-hour writes, then 2k 5-minute writes.
    expect(row.builder_cost_usd).toBeCloseTo(
      5 * 2e-6 +
        1_000 * 1e-5 +
        20_000 * 1e-7 +
        1_000 * 2.5e-6 +
        3_000 * 4e-6 +
        100 * 1e-5 +
        2_000 * 2.5e-6,
      9,
    );
    expect(row.planner_cache_write_tokens).toBe(20_000);
    expect(row.builder_cache_write_tokens).toBe(6_000);
    expect(row.builder_output_tokens).toBe(1_100);
    const calls = JSON.parse(row.calls_json) as ReadonlyArray<{ id: string; side: string }>;
    expect(calls.map((call) => [call.id, call.side])).toEqual([
      ["m1", "planner"],
      ["m2", "builder"],
      ["m3", "builder"],
    ]);
  }).pipe(Effect.provide(personalTestDatabase)),
);
