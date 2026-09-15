import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A saved login the user marked as a sensitive site (bank, email, health).
 *
 * After a bot has had that origin open in the shared browser, any action that
 * could carry what it saw to a different origin pauses for the user first
 * (the browser egress guard). Every other site stays unattended, so the flag
 * defaults off and existing logins keep today's behaviour.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_logins
    ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0
  `;
});
