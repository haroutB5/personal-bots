import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `seq` is an explicit INTEGER PRIMARY KEY (a rowid alias) because the FTS
  // index is external-content and keyed by rowid: VACUUM (and VACUUM INTO
  // backups) may renumber IMPLICIT rowids, which would silently desync the
  // index. memory_id stays the public, unique identifier.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_memory (
      seq INTEGER PRIMARY KEY,
      memory_id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      scope_id TEXT,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      version INTEGER NOT NULL DEFAULT 1
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_scope
    ON personal_memory(scope, scope_id, deleted_at)
  `;

  // One summary per task, even after the user deletes it (the tombstone keeps
  // the source), so a replayed completion never re-adds a deleted summary.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_memory_task_summary
    ON personal_memory(source) WHERE kind = 'task_summary'
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS personal_memory_fts USING fts5(
      content,
      content='personal_memory',
      content_rowid='seq',
      tokenize='unicode61 remove_diacritics 2'
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS personal_memory_fts_insert
    AFTER INSERT ON personal_memory BEGIN
      INSERT INTO personal_memory_fts(rowid, content) VALUES (new.seq, new.content);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS personal_memory_fts_delete
    AFTER DELETE ON personal_memory BEGIN
      INSERT INTO personal_memory_fts(personal_memory_fts, rowid, content)
      VALUES ('delete', old.seq, old.content);
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS personal_memory_fts_update
    AFTER UPDATE OF content ON personal_memory BEGIN
      INSERT INTO personal_memory_fts(personal_memory_fts, rowid, content)
      VALUES ('delete', old.seq, old.content);
      INSERT INTO personal_memory_fts(rowid, content) VALUES (new.seq, new.content);
    END
  `;

  // Which entries a turn was given. task_id/attempt reference the active
  // personal task attempt on the thread, when there is one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_memory_usage (
      usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      task_id TEXT,
      attempt INTEGER,
      memory_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_usage_task
    ON personal_memory_usage(task_id, attempt)
  `;
});
