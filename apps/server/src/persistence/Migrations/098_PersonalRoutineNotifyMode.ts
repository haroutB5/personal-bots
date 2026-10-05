import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Whether a routine's finished runs push a notification, and what a run
 * decided. Additive only.
 *
 * `personal_routines.notify_mode`: always (default, today's behaviour: every
 * run notifies), bot_decides (a completed run notifies only when the bot calls
 * notify_user with notify true) or never. Every existing routine keeps
 * 'always'.
 *
 * `personal_tasks` gets three nullable columns: the mode the run started with
 * (copied from its routine, so deleting or editing the routine mid-run does
 * not change this run), and the bot's last notify_user decision and message.
 * NULL everywhere for every task that already exists.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_routines
    ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'always'
    CHECK (notify_mode IN ('always', 'bot_decides', 'never'))
  `;
  yield* sql`
    ALTER TABLE personal_tasks
    ADD COLUMN notify_mode TEXT
    CHECK (notify_mode IS NULL OR notify_mode IN ('always', 'bot_decides', 'never'))
  `;
  yield* sql`
    ALTER TABLE personal_tasks
    ADD COLUMN notify_decision INTEGER
    CHECK (notify_decision IS NULL OR notify_decision IN (0, 1))
  `;
  yield* sql`ALTER TABLE personal_tasks ADD COLUMN notify_message TEXT`;
});
