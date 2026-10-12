import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Removes the pending turn-start rows stranded by the steer bug (QA 1.66.28;
 * live rows dated 10 Oct): a message steered into a running Claude turn was
 * folded into that turn, so no turn.started ever consumed the row the
 * projection inserted at thread.turn-start-requested, and nothing else clears
 * the shape either.
 *
 * 1.66.33 clears the row when the provider reports the steered message taken
 * in (ProjectionPipeline, user-message.delivered), so this only clears what is
 * already stranded. Exact stale shape only - the same shape
 * ProjectionTurnRepository.clearPendingProjectionTurnsByThread treats as
 * clearable (turn_id NULL, state 'pending', no checkpoint count). Migrations
 * run before the server serves, so no live turn can match.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{ readonly stale: number }>`
    SELECT count(*) AS stale
    FROM projection_turns
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND checkpoint_turn_count IS NULL
  `;
  const stale = rows[0]?.stale ?? 0;
  if (stale > 0) {
    yield* Effect.logInfo("removing stranded pending turn-start rows", { rows: stale });
  }

  yield* sql`
    DELETE FROM projection_turns
    WHERE turn_id IS NULL
      AND state = 'pending'
      AND checkpoint_turn_count IS NULL
  `;
});
