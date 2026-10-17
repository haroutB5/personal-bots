import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Turn-start rows of a previous process that no turn can ever consume.
 *
 * `thread.turn-start-requested` inserts a pending row (turn_id NULL, state
 * 'pending'); the turn it asks for consumes it, and ProjectionPipeline clears it
 * when the owner's message was folded into a running turn, when the turn start
 * failed, or when the session leaves the running state. A process that dies
 * between the request and the turn start (a restart while a steered or queued
 * message waits) leaves the row behind with nothing left to clear it: at boot
 * no provider session is running, so every pending turn start is stale by
 * definition.
 *
 * Additive and idempotent: it deletes only the exact stranded shape (the one
 * migration 106 removed once) and touching nothing else. Rows a *live* turn
 * owns always carry a turn_id.
 */
export const clearStrandedTurnStarts = Effect.fn("clearStrandedTurnStarts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly stale: number }>`
    SELECT count(*) AS stale
    FROM projection_turns
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND checkpoint_turn_count IS NULL
  `;
  const stale = rows[0]?.stale ?? 0;
  if (stale === 0) return 0;
  yield* sql`
    DELETE FROM projection_turns
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND checkpoint_turn_count IS NULL
  `;
  yield* Effect.logInfo("cleared stranded pending turn-start rows left by the last process", {
    rows: stale,
  });
  return stale;
});

/** For the startup fork: logs anything unexpected instead of failing the boot. */
export const clearStrandedTurnStartsSafely = clearStrandedTurnStarts().pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning("clearing stranded pending turn-start rows failed", {
          cause: Cause.pretty(cause),
        }),
  ),
  Effect.asVoid,
);
