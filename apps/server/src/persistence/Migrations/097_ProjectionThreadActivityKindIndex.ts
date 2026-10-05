import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Startup looks up the worktree-setup records with `WHERE kind = ?`
 * (`reconcileWorktreeSetups`), and nothing indexed `kind`, so it read every
 * activity row of every thread: 208,748 rows on the live data, 6.5 s cold.
 * With this index it reads only the rows of that kind. Additive only.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_thread
    ON projection_thread_activities(kind, thread_id)
  `;
});
