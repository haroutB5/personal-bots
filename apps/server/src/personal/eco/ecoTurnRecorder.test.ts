import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
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
