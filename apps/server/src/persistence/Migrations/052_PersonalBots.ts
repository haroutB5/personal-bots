import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      avatar_shape TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_bot_threads (
      thread_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES personal_bots(bot_id),
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_bot_threads_bot_id
    ON personal_bot_threads(bot_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;
});
