import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The call summary on a card (Harout, 16 Oct 2026). Additive only: three
 * `ALTER TABLE ADD COLUMN`s, no table is rebuilt and nothing is dropped, so a
 * rollback to the previous binary still boots against a database this migration
 * has touched.
 *
 * - `summary_json` holds the JSON of one `VoiceCallSummary` (`summary`,
 *   `points`, `decision`, `open`), or `''` while it is still being written or
 *   when it could not be written at all. A card with `''` shows its transcript
 *   exactly as it did before this feature existed, which is why every read
 *   treats an empty or unparseable value as "no summary", never as an error.
 * - `summary_attempts` counts the model attempts a call has had. It is stored,
 *   not remembered in the process, so a sweep can skip a call that is out of
 *   attempts and reach the older calls behind it instead of re-reading the same
 *   five failed rows forever (Astra review, finding 5).
 * - `summary_delivered_at` is written when the summary is actually put into a
 *   turn's context. Eligibility is that timestamp and never "has the bot
 *   replied since the call", because a reply that lands before the summary is
 *   written would otherwise retire a summary the bot never saw (Astra review,
 *   finding 3).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE personal_voice_calls
    ADD COLUMN summary_json TEXT NOT NULL DEFAULT ''
  `;
  yield* sql`
    ALTER TABLE personal_voice_calls
    ADD COLUMN summary_attempts INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE personal_voice_calls
    ADD COLUMN summary_delivered_at TEXT NOT NULL DEFAULT ''
  `;
});
