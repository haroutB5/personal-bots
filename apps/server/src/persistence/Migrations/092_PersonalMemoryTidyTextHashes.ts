import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A pending memory change remembers the text of every entry it names, as a
 * hash per entry, as the owner was shown it. Approval holds each entry to that
 * text, so a reach or kind change approved in between (which bumps the
 * version) no longer makes the change stale, while any edit to the text still
 * does. Additive only: rows without it keep the strict version check.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE personal_memory_tidy_changes ADD COLUMN text_hashes_json TEXT`;
});
