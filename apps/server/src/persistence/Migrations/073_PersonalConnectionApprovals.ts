import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per decision about one normalized action. The action digest is
  // indexed but not unique: the same action asked for twice, minutes apart,
  // is two decisions, and the history of what was allowed is the receipt.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_connection_approvals (
      approval_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL CHECK (vendor_id IN ('github', 'vercel', 'neon', 'upstash')),
      operation_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      risk_reason TEXT NOT NULL CHECK (
        risk_reason IN (
          'read_only', 'account_write', 'publication', 'deployment', 'unbounded_statement'
        )
      ),
      summary TEXT NOT NULL,
      target_resources_json TEXT NOT NULL DEFAULT '[]',
      credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
      thread_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'approved', 'denied', 'cancelled', 'expired')
      ),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      executed_at TEXT,
      execution_outcome TEXT CHECK (
        execution_outcome IS NULL
        OR execution_outcome IN ('succeeded', 'failed', 'not_dispatched')
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_connection_approvals_digest
    ON personal_connection_approvals(action_digest, status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_connection_approvals_status
    ON personal_connection_approvals(status)
  `;
});
