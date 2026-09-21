import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_connections (
      connection_id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL UNIQUE CHECK (vendor_id IN ('github', 'vercel', 'neon', 'upstash')),
      status TEXT NOT NULL CHECK (
        status IN ('connecting', 'connected', 'needs_reauth', 'disabled', 'error')
      ),
      account_id TEXT,
      account_name TEXT,
      team_id TEXT,
      team_name TEXT,
      verified_capabilities_json TEXT NOT NULL DEFAULT '[]',
      credential_ref TEXT NOT NULL UNIQUE,
      credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
      last_validated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_connections_status
    ON personal_connections(status)
  `;
});
