/**
 * Stores one Eco turn in `personal_eco_turns` (migration 165): the planner's
 * and the builder's tokens, cache reads and writes kept apart, and the cost of
 * each side priced with the Usage tab's rate table (`UsageService.priceUsage`).
 * Each API call is priced from its own usage, 5-minute and 1-hour cache writes
 * at their own rates; the SDK's summed `modelUsage` (which merges the two) is
 * only the fallback for a side with no per-call usage. Claude Code's own
 * figure is kept beside it for comparison.
 *
 * Recording never fails a turn: a write or pricing error is logged.
 *
 * @module personal/eco/ecoTurnRecorder
 */
import type {
  ProviderAdapterV2EcoCallUsage,
  ProviderAdapterV2EcoOutcome,
  ProviderAdapterV2EcoUsage,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type * as UsageService from "../../usage/UsageService.ts";
import { ledgerKeyMatches } from "./ecoMode.ts";

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

/** The list price of one API call from its own usage, or null when the model has no rate. */
export const priceEcoCall = (
  priceUsage: Pricer | undefined,
  call: ProviderAdapterV2EcoCallUsage,
  timestampMs: number,
): Effect.Effect<number | null> => {
  if (priceUsage === undefined || call.model.length === 0) return Effect.succeed(null);
  const written = call.cacheWrite5mTokens + call.cacheWrite1hTokens;
  if (call.inputTokens + call.outputTokens + call.cacheReadTokens + written === 0) {
    return Effect.succeed(0);
  }
  return priceUsage({
    provider: "claude",
    timestampMs,
    model: call.model,
    totals: {
      uncachedInputTokens: call.inputTokens,
      cachedInputTokens: call.cacheReadTokens,
      cacheCreationTokens: written,
      outputTokens: call.outputTokens,
      reasoningTokens: 0,
    },
    cacheCreation1hTokens: call.cacheWrite1hTokens,
    reportedCostUsd: null,
    speed: "standard",
  }).pipe(Effect.map((priced) => (priced.costSource === "unpriced" ? null : priced.costUsd)));
};

interface PricedSide {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number | null;
}

/**
 * One side's tokens and cost: summed call by call when the turn carried
 * per-call usage for that side's model, else priced from the summed usage.
 */
const priceSide = (
  priceUsage: Pricer | undefined,
  side: ProviderAdapterV2EcoUsage,
  calls: ReadonlyArray<{
    readonly call: ProviderAdapterV2EcoCallUsage;
    readonly costUsd: number | null;
  }>,
  timestampMs: number,
): Effect.Effect<PricedSide> => {
  const own = calls.filter((entry) => ledgerKeyMatches(entry.call.model, side.model));
  if (own.length === 0) {
    return priceEcoSide(priceUsage, side, timestampMs).pipe(
      Effect.map((costUsd) => ({
        inputTokens: side.inputTokens,
        outputTokens: side.outputTokens,
        cacheReadTokens: side.cacheReadTokens,
        cacheWriteTokens: side.cacheWriteTokens,
        costUsd,
      })),
    );
  }
  let costUsd: number | null = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const { call, costUsd: callCost } of own) {
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
    cacheReadTokens += call.cacheReadTokens;
    cacheWriteTokens += call.cacheWrite5mTokens + call.cacheWrite1hTokens;
    costUsd = costUsd === null || callCost === null ? null : costUsd + callCost;
  }
  return Effect.succeed({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd });
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
      const pricedCalls = yield* Effect.forEach(outcome.callUsage ?? [], (call) =>
        priceEcoCall(deps.priceUsage, call, at).pipe(Effect.map((costUsd) => ({ call, costUsd }))),
      );
      const planner = yield* priceSide(deps.priceUsage, outcome.planner, pricedCalls, at);
      const builder = yield* priceSide(deps.priceUsage, outcome.builder, pricedCalls, at);
      const sdkCost = {
        planner: outcome.planner.sdkCostUsd,
        builder: outcome.builder.sdkCostUsd,
        other: outcome.other.map((entry) => ({ model: entry.model, usd: entry.sdkCostUsd })),
      };
      const sideOf = new Map(outcome.calls.map((call) => [call.id, call.side]));
      // Every call with its own usage and price when the turn carried them, else the root calls.
      const callsJson =
        outcome.callUsage === undefined
          ? outcome.calls
          : pricedCalls.map(({ call, costUsd }) => ({
              ...call,
              side:
                sideOf.get(call.id) ??
                (ledgerKeyMatches(call.model, outcome.planner.model)
                  ? "planner"
                  : ledgerKeyMatches(call.model, outcome.builder.model)
                    ? "builder"
                    : "other"),
              costUsd,
            }));
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
          ${outcome.planner.calls}, ${planner.inputTokens}, ${planner.outputTokens},
          ${planner.cacheReadTokens}, ${planner.cacheWriteTokens}, ${planner.costUsd},
          ${outcome.builder.calls}, ${builder.inputTokens}, ${builder.outputTokens},
          ${builder.cacheReadTokens}, ${builder.cacheWriteTokens}, ${builder.costUsd},
          ${JSON.stringify(sdkCost)}, ${JSON.stringify(callsJson)},
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
