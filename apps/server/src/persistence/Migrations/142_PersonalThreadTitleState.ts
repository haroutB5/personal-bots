import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who wrote a personal chat's title. The v2 thread projection has no title
 * provenance, but the title rules need it: a manual rename always wins, a
 * first-message seed may be replaced once, and the task-title backfill leaves
 * a manual "New chat" alone.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_thread_title_state (
      thread_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
