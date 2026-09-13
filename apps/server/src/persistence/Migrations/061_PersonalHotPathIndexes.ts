import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Files tab: only rows that carry attachments, newest first per thread,
  // instead of a full scan of every projected message in the install.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_attachments
    ON projection_thread_messages(thread_id, created_at DESC, message_id DESC)
    WHERE attachments_json IS NOT NULL AND attachments_json <> '[]'
  `;

  // Routine history is read per routine, newest first, every 30s while the
  // Tasks tab is open; it had no index at all.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_routine_occurrences_routine
    ON personal_routine_occurrences(routine_id, created_at DESC)
  `;
});
