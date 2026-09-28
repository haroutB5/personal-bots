import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A bot chat whose turn stopped on a provider usage limit, and whether the
 * server continued it after the reset. One row per limit hit (thread + the
 * turn that hit it), which is what keeps a hit from resuming twice, including
 * across a restart. `resume_at` NULL means no reset was reported: the chat
 * only shows the notice.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_chat_resumes (
      resume_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      hit_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      limit_reason TEXT,
      hit_at TEXT NOT NULL,
      resume_at TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('scheduled', 'resumed', 'skipped', 'notice_only')),
      outcome TEXT,
      resolved_at TEXT,
      UNIQUE (thread_id, hit_key)
    )
  `;
  yield* sql`
    CREATE INDEX idx_personal_chat_resumes_status
    ON personal_chat_resumes (status, resume_at)
  `;
});
