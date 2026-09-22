import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What a bot has had open on a site the owner marked sensitive, kept where a
 * restart cannot drop it.
 *
 * The egress guard used to hold this in process memory, on the reasoning that
 * the provider session that saw the page dies with the process. It does not:
 * sessions are recovered with their resume cursor, so after every restart the
 * model still held the page while the guard reported a clean thread.
 *
 * One row per (key, kind, value). `exposure_key` is `thread:<id>`,
 * `root:<task id>` or `group:<id>`; `kind` is `source` (a sensitive origin
 * that was open) or `approved` (a destination the owner allowed that content
 * to go to). Additive only: rows are never rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_sensitive_exposures (
      exposure_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('source', 'approved')),
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (exposure_key, kind, value)
    )
  `;
});
