import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // max_depth / max_children are read from the ROOT row, so the limits a
  // root was created with survive restarts and later default changes.
  // available_at gates rate-limited backoff; NULL means claimable now.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_tasks (
      task_id TEXT PRIMARY KEY,
      root_task_id TEXT NOT NULL,
      parent_task_id TEXT,
      bot_id TEXT NOT NULL,
      thread_id TEXT,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      expected_output TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      depth INTEGER NOT NULL,
      max_depth INTEGER NOT NULL,
      max_children INTEGER NOT NULL,
      result_json TEXT,
      error_category TEXT,
      error_message TEXT,
      available_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_tasks_status
    ON personal_tasks(status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_tasks_root
    ON personal_tasks(root_task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_tasks_parent
    ON personal_tasks(parent_task_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_tasks_thread
    ON personal_tasks(thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_task_attempts (
      task_id TEXT NOT NULL REFERENCES personal_tasks(task_id),
      attempt INTEGER NOT NULL,
      provider_thread_id TEXT NOT NULL,
      turn_id TEXT,
      lease_owner TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      error_category TEXT,
      resumable INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, attempt)
    )
  `;

  // Active attempts (ended_at IS NULL) are the execution slots.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_task_attempts_active
    ON personal_task_attempts(ended_at, provider_thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_handoffs (
      parent_task_id TEXT NOT NULL REFERENCES personal_tasks(task_id),
      child_task_id TEXT PRIMARY KEY REFERENCES personal_tasks(task_id),
      brief_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      result_summary TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_handoffs_parent
    ON personal_handoffs(parent_task_id)
  `;
});
