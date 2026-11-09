import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The personal turn-retry marker. v1 kept it inside the session's
 * `providerRetry` JSON, and v2 has no session row to hold it, so the personal
 * layer owns one small table instead. `auto` is the server's own retry state;
 * the provider's own wait is read from the run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_thread_retry (
      thread_id TEXT PRIMARY KEY,
      attempt INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      retry_at TEXT,
      auto TEXT NOT NULL,
      provider TEXT NOT NULL,
      observed_at TEXT NOT NULL
    )
  `;
});
