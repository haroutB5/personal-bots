import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // next_due_utc is the instant of the next wall-clock slot (NULL once a
  // one-off has run). The dispatcher reads only the DB, never client timers.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_routines (
      routine_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      time_zone TEXT NOT NULL DEFAULT 'Europe/London',
      enabled INTEGER NOT NULL DEFAULT 1,
      missed_policy TEXT NOT NULL DEFAULT 'coalesce',
      next_due_utc TEXT,
      last_occurrence_local TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_routines_due
    ON personal_routines(enabled, next_due_utc)
  `;

  // The primary key is the dedupe guard: one row per nominal local slot, so a
  // restart or a clock change can never fire the same slot twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_routine_occurrences (
      routine_id TEXT NOT NULL,
      local_occurrence TEXT NOT NULL,
      due_utc TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (routine_id, local_occurrence)
    )
  `;
});
