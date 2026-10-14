import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive indexes for two lookups behind the server's event-loop freezes
// (stall reports and "sql NNN ms" lines, 10-14 Oct). Both queries keep their
// shape; the indexes only let them stop reading table rows.
//
// Bots list (PersonalBotRepository.listThreadLinkRows, every personalBots.list):
// per chat it takes the newest message that is not a system or reasoning row,
// once for the activity time and once for the preview id. Role is not in the
// (thread_id, created_at, message_id) index, so each step back from the newest
// row read the message row itself (text and all) just to test its role. With
// role at the end the walk stays in the index. Measured on a copy of the
// 14 Oct backup: 19.7 MB read per call -> 8.0 MB, 8.4 s -> 0.12 s cold.
//
// Turn list (ProjectionSnapshotQuery.listActiveLatestTurnRows, every shell
// snapshot: pull-request refresh, settlement): the open threads' latest turn
// ids came from projection_threads rows; this index carries them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_id_role
    ON projection_thread_messages(thread_id, created_at, message_id, role)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_latest_turn
    ON projection_threads(deleted_at, archived_at, thread_id, latest_turn_id)
  `;
});
