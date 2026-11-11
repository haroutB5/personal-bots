import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A phone token belongs to the session that registered it and to that session's
 * subject. A notification row is readable only by the subject it was sent to.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_fcm_tokens (
      token TEXT PRIMARY KEY,
      auth_session_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      app_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_error TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_fcm_tokens_session
    ON personal_fcm_tokens(auth_session_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_phone_notifications (
      notification_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      request_id TEXT,
      body TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (notification_id, subject)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_phone_notifications_created
    ON personal_phone_notifications(created_at)
  `;
});
