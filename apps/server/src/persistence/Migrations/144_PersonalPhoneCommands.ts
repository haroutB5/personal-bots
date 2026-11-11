import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per phone notification action (a reply or a one-tap answer), keyed
 * by the command id the phone chose. The first call claims the row and later
 * calls with the same id get the stored result, so a retried tap sends one
 * message and answers one request.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_phone_commands (
      command_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      action TEXT NOT NULL,
      notification_id TEXT NOT NULL,
      status INTEGER,
      body TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (command_id, subject)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_phone_commands_created
    ON personal_phone_commands(created_at)
  `;
});
