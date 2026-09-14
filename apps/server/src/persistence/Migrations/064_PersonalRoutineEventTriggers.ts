import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Event-triggered routines. Existing rows are scheduled routines, so the
 * discriminator defaults to 'schedule' and every new column is nullable —
 * no rewrite, no backfill.
 *
 * `schedule_json` stays NOT NULL (dropping that needs a table rebuild). Event
 * routines store the JSON literal `null` in it, which the row schema decodes to
 * a real `null`, so the type system forces every reader to handle "no schedule"
 * instead of reading a placeholder that looks like a real cadence.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_routines
    ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'schedule'
  `;

  yield* sql`ALTER TABLE personal_routines ADD COLUMN hook_token TEXT`;
  yield* sql`ALTER TABLE personal_routines ADD COLUMN event_label TEXT`;
  yield* sql`ALTER TABLE personal_routines ADD COLUMN last_fired_utc TEXT`;

  // Partial: the webhook lookup only ever scans event routines, and scheduled
  // rows must be free to share a NULL token.
  yield* sql`
    CREATE UNIQUE INDEX idx_personal_routines_hook_token
    ON personal_routines(hook_token) WHERE hook_token IS NOT NULL
  `;

  // The tick sweep filters on the discriminator before the due time.
  yield* sql`
    CREATE INDEX idx_personal_routines_trigger_due
    ON personal_routines(trigger_kind, enabled, next_due_utc)
  `;
});
