import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per streamed notice chunk that has been written. appendNotice takes
 * a caller-supplied key so a retried chunk is applied once, which v1 got from
 * its command receipts and v2's EventSink does not provide.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_notice_chunks (
      message_id TEXT NOT NULL,
      chunk_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (message_id, chunk_key)
    )
  `;
});
