import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per approved plan being carried out. The plan is stored whole and
  // never edited: an approval binds to its hash, so a run whose plan changed
  // would be a run nobody approved.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_create_app_runs (
      run_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      task_id TEXT,
      plan_json TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      approval_id TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('awaiting_approval', 'running', 'completed', 'needs_attention', 'declined')
      ),
      app_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The same plan asked for twice in the same chat is one run, not two. This
  // is what makes an unchanged plan resume rather than start again, and it is
  // enforced here rather than by a read-then-write the second caller can race.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_create_app_runs_plan
    ON personal_create_app_runs(thread_id, plan_digest)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_create_app_runs_status
    ON personal_create_app_runs(status)
  `;

  // One row per step, written before the provider is called and again after.
  // `in_flight` is the state that makes a crash survivable: it says the
  // provider was asked and we do not know what it did, which is the only
  // honest thing to record between sending a request and reading its reply.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_create_app_steps (
      run_id TEXT NOT NULL REFERENCES personal_create_app_runs(run_id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      title TEXT NOT NULL,
      position INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('pending', 'in_flight', 'done', 'failed', 'skipped')
      ),
      attempts INTEGER NOT NULL DEFAULT 0,
      remote_id TEXT,
      adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1)),
      receipt_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at TEXT,
      ended_at TEXT,
      PRIMARY KEY (run_id, step_id)
    )
  `;
});
