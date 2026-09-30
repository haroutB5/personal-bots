import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Additive metadata only. Neither credential has a column. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE personal_login_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      label TEXT NOT NULL,
      reason TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'filling', 'filled', 'cancelled', 'expired', 'origin-mismatch', 'fill-failed'
      )),
      saved INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0, 1)),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX personal_login_requests_thread ON personal_login_requests(thread_id, created_at)`;
  yield* sql`CREATE INDEX personal_login_requests_pending ON personal_login_requests(status, expires_at)`;
});
