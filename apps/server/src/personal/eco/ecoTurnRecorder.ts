/**
 * Stores one Eco turn in `personal_eco_turns` (migration 165): the planner's
 * and the builder's tokens, cache reads and writes kept apart, and the cost of
 * each side priced with the Usage tab's rate table (`UsageService.priceUsage`).
 * Claude Code's own figure is kept beside it for comparison.
 *
 * Recording never fails a turn: a write or pricing error is logged.
 *
 * @module personal/eco/ecoTurnRecorder
 */
import type {
  ProviderAdapterV2EcoOutcome,
  ProviderAdapterV2EcoUsage,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as UsageService from "../../usage/UsageService.ts";

type Pricer = UsageService.UsageService["Service"]["priceUsage"];

/** The list price of one side, or null when the model has no rate (or nothing was used). */
export const priceEcoSide = (
  priceUsage: Pricer | undefined,
  side: ProviderAdapterV2EcoUsage,
  timestampMs: number,
): Effect.Effect<number | null> => {
  if (priceUsage === undefined || side.model.length === 0) return Effect.succeed(null);
  const used = side.inputTokens + side.outputTokens + side.cacheReadTokens + side.cacheWriteTokens;
  if (used === 0) return Effect.succeed(0);
  return priceUsage({
    provider: "claude",
    timestampMs,
    model: side.model,
    totals: {
      uncachedInputTokens: side.inputTokens,
      cachedInputTokens: side.cacheReadTokens,
      cacheCreationTokens: side.cacheWriteTokens,
      outputTokens: side.outputTokens,
      reasoningTokens: 0,
    },
    // Priced from the table, not Claude Code's own figure, which is stored apart.
    reportedCostUsd: null,
    speed: "standard",
  }).pipe(Effect.map((priced) => (priced.costSource === "unpriced" ? null : priced.costUsd)));
};

export const makeEcoTurnRecorder =
  (deps: {
    readonly sql: Option.Option<SqlClient.SqlClient>;
    readonly priceUsage: Pricer | undefined;
    readonly newId: () => string;
  }) =>
  (botId: string | undefined, outcome: ProviderAdapterV2EcoOutcome): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (Option.isNone(deps.sql)) return;
      const sql = deps.sql.value;
      const at = outcome.completedAt.getTime();
      const plannerCost = yield* priceEcoSide(deps.priceUsage, outcome.planner, at);
      const builderCost = yield* priceEcoSide(deps.priceUsage, outcome.builder, at);
      const sdkCost = {
        planner: outcome.planner.sdkCostUsd,
        builder: outcome.builder.sdkCostUsd,
        other: outcome.other.map((entry) => ({ model: entry.model, usd: entry.sdkCostUsd })),
      };
      yield* sql`
        INSERT INTO personal_eco_turns (
          eco_turn_id, bot_id, thread_id, run_id, planner_model, builder_model,
          handed_off, eco_skipped, handoff_error, plan_markdown, status,
          planner_calls, planner_input_tokens, planner_output_tokens,
          planner_cache_read_tokens, planner_cache_write_tokens, planner_cost_usd,
          builder_calls, builder_input_tokens, builder_output_tokens,
          builder_cache_read_tokens, builder_cache_write_tokens, builder_cost_usd,
          sdk_cost_usd_json, calls_json, started_at, handed_off_at, completed_at
        ) VALUES (
          ${deps.newId()}, ${botId ?? null}, ${outcome.threadId}, ${outcome.runId},
          ${outcome.planner.model}, ${outcome.builder.model},
          ${outcome.handedOff ? 1 : 0}, ${outcome.ecoSkipped ?? null},
          ${outcome.handoffError ?? null}, ${outcome.plan ?? null},
          ${outcome.status},
          ${outcome.planner.calls}, ${outcome.planner.inputTokens}, ${outcome.planner.outputTokens},
          ${outcome.planner.cacheReadTokens}, ${outcome.planner.cacheWriteTokens}, ${plannerCost},
          ${outcome.builder.calls}, ${outcome.builder.inputTokens}, ${outcome.builder.outputTokens},
          ${outcome.builder.cacheReadTokens}, ${outcome.builder.cacheWriteTokens}, ${builderCost},
          ${JSON.stringify(sdkCost)}, ${JSON.stringify(outcome.calls)},
          ${outcome.startedAt.toISOString()},
          ${outcome.handedOffAt === undefined ? null : outcome.handedOffAt.toISOString()},
          ${outcome.completedAt.toISOString()}
        )
      `;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("personal eco turn could not be recorded", {
              threadId: outcome.threadId,
              runId: outcome.runId,
              cause: Cause.pretty(cause).slice(0, 1_000),
            }),
      ),
    );
