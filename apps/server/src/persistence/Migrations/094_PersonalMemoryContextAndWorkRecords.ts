import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Two additive pieces for 1.60.41:
 * - a task's durable work record (personal_task_work_records): objective,
 *   decisions, evidence, outstanding work and next step as one JSON document,
 *   kept apart from the chat transcript and fed to a reopened task;
 * - the "Context used" view: each turn's memory use now also records the
 *   message that started the turn and a compact trace of why each entry was
 *   picked or left out (personal_memory_usage.message_id, trace_json), and
 *   the owner's "outdated" / "not relevant" marks on notes and task summaries
 *   (personal_memory_feedback), which rank an entry lower and never delete it.
 *
 * Older code ignores every new column and table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_task_work_records (
      task_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_memory_feedback (
      memory_id TEXT PRIMARY KEY,
      signal TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`ALTER TABLE personal_memory_usage ADD COLUMN message_id TEXT`;
  yield* sql`ALTER TABLE personal_memory_usage ADD COLUMN trace_json TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_usage_message
    ON personal_memory_usage(thread_id, message_id)
  `;
  // Old traces are cleared in small batches by age.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_memory_usage_created
    ON personal_memory_usage(created_at)
  `;
});
