import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A pending memory change remembers each entry it names as the owner was
 * shown it: a hash of its text, its kind and its reach (scope and team). The
 * entries it archives, merges, forgets or reclassifies must still match all
 * of that when the owner answers; the newer entry a supersede keeps only has
 * to keep its text. Additive only: rows without it keep the strict version
 * check.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE personal_memory_tidy_changes ADD COLUMN entry_snapshots_json TEXT`;
});
