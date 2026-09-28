import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A group round whose member (or final verdict) was cut off by a provider usage
 * limit that reported a reset time, and whether the server carried on with it
 * after the reset. One scheduled row per round and kind: members cut off by the
 * same round before the reset share it. The status only ever moves off
 * `scheduled` once, which is what keeps a hit from resuming twice, including
 * across a restart.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_group_limit_resumes (
      resume_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('members', 'verdict')),
      bot_ids_json TEXT NOT NULL,
      provider TEXT NOT NULL,
      limit_reason TEXT,
      hit_at TEXT NOT NULL,
      resume_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'resumed', 'skipped')),
      outcome TEXT,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_personal_group_limit_resumes_scheduled
    ON personal_group_limit_resumes (round_id, kind)
    WHERE status = 'scheduled'
  `;
  yield* sql`
    CREATE INDEX idx_personal_group_limit_resumes_status
    ON personal_group_limit_resumes (status, resume_at)
  `;
});
