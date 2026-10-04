import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * App-scoped rules: an entry may be limited to one or more apps (a JSON array
 * of app slugs such as ["matchday"]). Null, every existing row, means global:
 * the entry reaches every bot that can see it, as before. A bot's turn lists a
 * scoped rule in full only when its chat is about one of those apps, and
 * counts the rest in a one-line index.
 *
 * A pending "rescope" change stores the apps it would set in `to_apps_json`
 * (null: back to global). Additive only: older code ignores both columns.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN apps_json TEXT`;
  yield* sql`ALTER TABLE personal_memory_tidy_changes ADD COLUMN to_apps_json TEXT`;
});
