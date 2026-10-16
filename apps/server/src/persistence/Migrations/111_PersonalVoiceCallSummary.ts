import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The call summary on a card (Harout, 16 Oct 2026). Additive only: one column,
 * `ALTER TABLE ADD COLUMN`, so a rollback to the previous binary still boots
 * against a database this migration has touched.
 *
 * The column holds the JSON of one `VoiceCallSummary` (`summary`, `points`,
 * `decision`, `open`), or `''` while it is still being written or when it could
 * not be written at all. A card with `''` shows its transcript exactly as it did
 * before this feature existed, which is why every read treats an empty or
 * unparseable value as "no summary" rather than as an error.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE personal_voice_calls
    ADD COLUMN summary_json TEXT NOT NULL DEFAULT ''
  `;
});
