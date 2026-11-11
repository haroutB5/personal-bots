import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Binds a browser push subscription to the session that registered it. Nullable:
 * a row from before this has no session and receives nothing until its browser
 * re-sends it. No row is deleted here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('personal_push_subscriptions')
  `;
  if (!columns.some((column) => column.name === "auth_session_id")) {
    yield* sql`ALTER TABLE personal_push_subscriptions ADD COLUMN auth_session_id TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_push_subscriptions_session
    ON personal_push_subscriptions(auth_session_id)
  `;
});
