import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The approvals table catches up with the connection catalog.
 *
 * 075 widened `personal_connections` for WhatsApp but left the approvals
 * table on the four-vendor CHECK, so every WhatsApp send (which always needs
 * a card) failed to insert its approval. SQLite widens a CHECK only by
 * rebuilding the table, so this copies every row across; the migrator runs it
 * inside one transaction, so a failure leaves the old table untouched.
 *
 * `execution_outcome` also gains `dispatching`: the gateway now claims an
 * approval before it calls the vendor rather than writing the receipt after,
 * so two identical calls (or a crash mid-call) cannot spend one approval
 * twice. A row left at `dispatching` by a crash stays spent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_connection_approvals_new (
      approval_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL CHECK (
        vendor_id IN ('github', 'vercel', 'neon', 'upstash', 'whatsapp')
      ),
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
        OR execution_outcome IN ('dispatching', 'succeeded', 'failed', 'not_dispatched')
      )
    )
  `;

  yield* sql`
    INSERT INTO personal_connection_approvals_new (
      approval_id, connection_id, vendor_id, operation_id, action_digest, risk_reason,
      summary, target_resources_json, credential_version, thread_id, bot_id, task_id,
      status, created_at, expires_at, decided_at, executed_at, execution_outcome
    )
    SELECT
      approval_id, connection_id, vendor_id, operation_id, action_digest, risk_reason,
      summary, target_resources_json, credential_version, thread_id, bot_id, task_id,
      status, created_at, expires_at, decided_at, executed_at, execution_outcome
    FROM personal_connection_approvals
  `;

  yield* sql`DROP TABLE personal_connection_approvals`;
  yield* sql`ALTER TABLE personal_connection_approvals_new RENAME TO personal_connection_approvals`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_connection_approvals_digest
    ON personal_connection_approvals(action_digest, status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_connection_approvals_status
    ON personal_connection_approvals(status)
  `;
});
