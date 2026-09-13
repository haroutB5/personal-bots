import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The shell stream re-reads each thread's projected session from this table,
// so a provider rate limit / retry wait needs a column to reach clients.
// Nullable JSON (OrchestrationSessionProviderRetry); idempotent so the id can
// be renumbered without re-running the ALTER.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  if (!columns.some((column) => column.name === "provider_retry_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_retry_json TEXT
    `;
  }
});
