import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Partial index on `personal_memory.superseded_by` so temporal/history queries
 * can walk replacement chains backward without scanning the full table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_superseded_by
    ON personal_memory(superseded_by)
    WHERE superseded_by IS NOT NULL
  `;
});
