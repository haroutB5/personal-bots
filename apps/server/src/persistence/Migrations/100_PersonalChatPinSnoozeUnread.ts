import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Chat extras (1.65.0): pin, snooze and "mark unread", stored on the server so
 * the phone and the laptop agree. Additive only: every column is nullable, so
 * every chat that exists starts unpinned, awake and not marked.
 *
 * - `pinned_at`: when the owner pinned the chat (pinned chats sit at the top).
 * - `snoozed_until`: when the chat wakes. A time in the past is a snooze that
 *   ran out: the chat is back and unread from that moment.
 * - `marked_unread_at`: when the owner marked the chat unread; it counts as
 *   unread until `last_viewed_at` passes it.
 *
 * Groups get pin and snooze (they have no unread state to mark).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_bot_threads ADD COLUMN pinned_at TEXT`;
  yield* sql`ALTER TABLE personal_bot_threads ADD COLUMN snoozed_until TEXT`;
  yield* sql`ALTER TABLE personal_bot_threads ADD COLUMN marked_unread_at TEXT`;
  yield* sql`ALTER TABLE personal_groups ADD COLUMN pinned_at TEXT`;
  yield* sql`ALTER TABLE personal_groups ADD COLUMN snoozed_until TEXT`;
});
