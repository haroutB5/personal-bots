import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Finished delegated-task chats archive themselves after 30 idle minutes
 * (PersonalTaskChatArchiveService).
 *
 * - `last_viewed_at`: when the owner last had the chat open on a device
 *   (from the page's viewing heartbeat, written at most once a minute). The
 *   idle clock restarts from it, also across a restart.
 * - `auto_archived_at`: set once the sweep archived the chat. It is never
 *   cleared, so a chat the owner unarchives is not archived again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_bot_threads ADD COLUMN last_viewed_at TEXT`;
  yield* sql`ALTER TABLE personal_bot_threads ADD COLUMN auto_archived_at TEXT`;
});
