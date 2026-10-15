import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Voice calls with a bot (Harout, 15 Oct 2026). Additive only.
 *
 * - `personal_bots.allow_voice_calls`: the bot form's "Allow voice calls"
 *   switch. Off for every bot that exists and for every new one, then turned
 *   on for the CTO alone: it is the only callable bot at launch.
 * - `personal_voice_calls`: one row per finished call, the card the chat shows.
 *   It is deliberately NOT a chat message: nothing here reaches a bot's model
 *   context, which is the whole point of storing the transcript beside the
 *   chat instead of inside it. `call_id` is the primary key, so `finish` is
 *   idempotent per call.
 *
 * Matched by name, like migration 069's teams: the bots are the owner's own
 * rows, not seeded ids, so a name that is missing simply matches nothing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_bots
    ADD COLUMN allow_voice_calls INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    UPDATE personal_bots
    SET allow_voice_calls = 1
    WHERE lower(trim(name)) = 'cto'
  `;

  yield* sql`
    CREATE TABLE personal_voice_calls (
      call_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      end_reason TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      voice_name TEXT NOT NULL,
      model TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      transcript_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX personal_voice_calls_thread_started
    ON personal_voice_calls (thread_id, started_at)
  `;
});
