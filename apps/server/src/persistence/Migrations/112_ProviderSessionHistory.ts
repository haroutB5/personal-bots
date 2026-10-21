import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Every provider session a chat has resumed, so the Token usage table can
 * attribute sessions a chat used before its resume cursor moved on (Harout,
 * 21 Oct 2026: 27% of tokens showed as "other" because only the current
 * session of each chat was known).
 *
 * Additive only: one new table, nothing renamed, rebuilt or dropped, so a
 * rollback to the previous binary still boots. The previous binary simply
 * ignores it and keeps attributing only the current session.
 *
 * - `(thread_id, provider_name, session_id)` is the key, so a chat that starts
 *   the same session twice records it once.
 * - `first_seen_at` is when the runtime first reported that session for the
 *   chat; it is never updated, because nothing reads it as an activity time.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_session_history (
      thread_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, provider_name, session_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_history_session
    ON provider_session_history(provider_name, session_id)
  `;
});
