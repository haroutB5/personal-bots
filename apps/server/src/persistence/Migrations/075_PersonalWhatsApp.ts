import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * WhatsApp joins the connection catalog, and connections gain owner-visible
 * settings.
 *
 * The vendor list is a CHECK constraint, which SQLite can only widen by
 * rebuilding the table, so this copies rather than alters. `settings_json`
 * holds what the owner can see and change about one connection — today the
 * WhatsApp daily send cap — and is deliberately not the credential store:
 * a browser-session connection has no credential, and its `credential_ref` is
 * a marker with nothing behind it.
 *
 * `personal_whatsapp_sends` is the pacing ledger. One row per message that
 * actually left, so a cap survives a restart: holding the count in memory
 * would reset it exactly when a crash loop is sending.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_connections_new (
      connection_id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL UNIQUE CHECK (
        vendor_id IN ('github', 'vercel', 'neon', 'upstash', 'whatsapp')
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
      verified_capabilities_json, '{}', credential_ref, credential_version,
      last_validated_at, created_at, updated_at
    FROM personal_connections
  `;

  yield* sql`DROP TABLE personal_connections`;
  yield* sql`ALTER TABLE personal_connections_new RENAME TO personal_connections`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_connections_status
    ON personal_connections(status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_whatsapp_sends (
      send_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      /* The number the message actually went to, so the ledger can be read
         back as "who did this account message", not just how many times. */
      recipient_number TEXT NOT NULL,
      sent_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_whatsapp_sends_connection
    ON personal_whatsapp_sends(connection_id, sent_at)
  `;
});
