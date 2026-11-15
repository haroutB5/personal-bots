import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The goal sheet's Why line and its recorded plan changes. Additive: existing
 * projects keep their rows, a null why and an empty history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE personal_projects ADD COLUMN why TEXT`;
  yield* sql`ALTER TABLE personal_projects ADD COLUMN history_json TEXT NOT NULL DEFAULT '[]'`;
});
