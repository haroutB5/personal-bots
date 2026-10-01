import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Memory that stays current: an entry can be superseded (by a newer save that
 * replaces it, or by the nightly tidy-up) instead of deleted. A superseded
 * entry keeps its text, is never given to a bot, and can be restored.
 *
 * The tidy-up's runs and every change it made (or left alone) are kept as its
 * changelog. Additive only: existing entries stay current.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_memory ADD COLUMN superseded_at TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN superseded_by TEXT`;
  yield* sql`ALTER TABLE personal_memory ADD COLUMN superseded_reason TEXT`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_superseded
    ON personal_memory(superseded_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_memory_tidy_runs (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0,
      nightly INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      merged INTEGER NOT NULL DEFAULT 0,
      superseded INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      left_alone INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_tidy_runs_started
    ON personal_memory_tidy_runs(started_at)
  `;

  // action: merge (memory_ids folded into a new entry), supersede (memory_ids
  // archived for result_memory_id, or retired when it is null) or leave.
  // status: applied, preview, pending (waits for the owner), approved,
  // rejected or left.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_memory_tidy_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      action TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT,
      memory_ids_json TEXT NOT NULL,
      result_memory_id TEXT,
      content TEXT,
      to_kind TEXT,
      to_scope TEXT,
      to_scope_id TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_tidy_changes_run
    ON personal_memory_tidy_changes(run_id)
  `;

  // How many entries hold each term: a turn's search uses a message's rarest
  // words instead of its first sixteen.
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS personal_memory_fts_vocab
    USING fts5vocab(personal_memory_fts, 'row')
  `;

  // One row. The nightly run starts as a preview: it changes nothing until
  // the owner has read what it would do and switched it on.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_memory_tidy_settings (
      settings_id INTEGER PRIMARY KEY CHECK (settings_id = 1),
      mode TEXT NOT NULL DEFAULT 'preview',
      updated_at TEXT
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO personal_memory_tidy_settings (settings_id, mode) VALUES (1, 'preview')
  `;
});
