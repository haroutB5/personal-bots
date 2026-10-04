import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A tidy-up change that is made on its own can be taken back from the Memory
 * screen's log: what it needs to put things back (the entries as they were
 * before a rescope or reclassify, the entries a split made) is kept with it.
 * Additive only. (The nightly mode's default moves to "on" at startup, not
 * here, so the kill switch can keep the old default.)
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE personal_memory_tidy_changes ADD COLUMN undo_json TEXT`;
});
