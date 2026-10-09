import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive: legacy entries retain unknown provenance and freshness.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN temporal_kind TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN observed_at TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN verified_at TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN evidence_json TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN origin_thread_id TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN origin_message_id TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN conflict TEXT`;
});
