import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A bot's request for a secret. The VALUE never lives here: it is only in
  // the server secret store under `personal-secret-<name>`.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_secret_requests (
      request_id TEXT PRIMARY KEY,
      root_task_id TEXT,
      task_id TEXT,
      thread_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      fulfilled_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_secret_requests_status
    ON personal_secret_requests(status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_secret_requests_name
    ON personal_secret_requests(name)
  `;

  // Text a task's next turn must open with (for example "secret X is now
  // available"). A note with restart_session waits until the thread's
  // provider session is gone, so the next turn starts a fresh process that
  // picks up new environment variables.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_task_resume_notes (
      note_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES personal_tasks(task_id),
      text TEXT NOT NULL,
      restart_session INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_task_resume_notes_task
    ON personal_task_resume_notes(task_id, delivered_at)
  `;
});
