import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive index for the per-thread newest-message lookups that every bot list
// and the 5-minute task-chat archive sweep run: max(created_at) filtered by
// role. The existing (thread_id, created_at, message_id) index seeks by
// created_at first, so each of these queries walks rows and touches the table
// for the role (and the `message_id NOT LIKE 'personal-%'` test) of every
// candidate. With role ahead of created_at the seek lands directly on the
// newest row of that role, and message_id in the index keeps the sweep's
// filter index-only. Measured on the live DB (11 Oct): these lookups were
// 1-6 s each when the disk was busy; the query shapes stay the same.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_role_created_id
    ON projection_thread_messages(thread_id, role, created_at, message_id)
  `;
});
