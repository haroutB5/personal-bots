import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Registry of owner-configured external Streamable HTTP MCP servers (such as a
 * self-hosted Executor instance) exposed to personal bots through the server's
 * sensitive-site-guarded reverse proxy. Bearer tokens live encrypted in
 * ServerSecretStore, never in this table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_external_mcp_servers (
      server_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      url TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('shared', 'team', 'bot')),
      scope_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      credential_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_external_mcp_servers_scope
    ON personal_external_mcp_servers(scope, scope_id, enabled)
  `;
});
