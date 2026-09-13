import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Last http(s) page the agent had open, so a server restart can reopen it and
 * re-attach the agent lease. NULL when nothing restorable was ever recorded.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_browser_leases
    ADD COLUMN last_url TEXT
  `;
});
