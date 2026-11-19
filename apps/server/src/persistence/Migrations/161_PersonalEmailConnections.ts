import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Gmail and Outlook join the catalog and may hold several connections each.
 * The five older vendors keep one row per vendor through a partial unique
 * index; a mailbox vendor is unique per (vendor, account).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_connections_new (
      connection_id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL CHECK (
        vendor_id IN ('github', 'vercel', 'neon', 'upstash', 'whatsapp', 'gmail', 'outlook')
      ),
      status TEXT NOT NULL CHECK (
        status IN ('connecting', 'connected', 'needs_reauth', 'disabled', 'error')
      ),
      account_id TEXT,
      account_name TEXT,
      team_id TEXT,
      team_name TEXT,
      verified_capabilities_json TEXT NOT NULL DEFAULT '[]',
      settings_json TEXT NOT NULL DEFAULT '{}',
      credential_ref TEXT NOT NULL UNIQUE,
      credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
      last_validated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO personal_connections_new (
      connection_id, vendor_id, status, account_id, account_name, team_id, team_name,
      verified_capabilities_json, settings_json, credential_ref, credential_version,
      last_validated_at, created_at, updated_at
    )
    SELECT
      connection_id, vendor_id, status, account_id, account_name, team_id, team_name,
      verified_capabilities_json, settings_json, credential_ref, credential_version,
      last_validated_at, created_at, updated_at
    FROM personal_connections
  `;

  yield* sql`DROP TABLE personal_connections`;
  yield* sql`ALTER TABLE personal_connections_new RENAME TO personal_connections`;

  yield* sql`
    CREATE UNIQUE INDEX ux_personal_connections_single
    ON personal_connections(vendor_id)
    WHERE vendor_id NOT IN ('gmail', 'outlook')
  `;
  yield* sql`
    CREATE UNIQUE INDEX ux_personal_connections_mailbox
    ON personal_connections(vendor_id, account_id)
    WHERE vendor_id IN ('gmail', 'outlook')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_connections_status
    ON personal_connections(status)
  `;

  yield* sql`
    CREATE TABLE personal_connection_approvals_new (
      approval_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      vendor_id TEXT NOT NULL CHECK (
        vendor_id IN ('github', 'vercel', 'neon', 'upstash', 'whatsapp', 'gmail', 'outlook')
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
