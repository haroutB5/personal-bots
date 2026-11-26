import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Vector embeddings for personal memory entries so retrieval can fuse FTS5
 * lexical matches with local semantic similarity via Reciprocal Rank Fusion.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_memory_embeddings (
      memory_id TEXT PRIMARY KEY REFERENCES personal_memory(memory_id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_embeddings_model
    ON personal_memory_embeddings(model)
  `;
});
