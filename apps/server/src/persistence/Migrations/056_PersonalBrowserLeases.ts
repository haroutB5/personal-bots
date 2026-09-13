import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One row per persistent browser profile. `generation` only ever grows: every
 * control change bumps it so an agent op captured under an older generation is
 * rejected. A released lease is `owner_type = 'agent'` with a NULL owner.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_browser_leases (
      profile_id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('agent', 'human')),
      owner_id TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      heartbeat_at TEXT,
      expires_at TEXT
    )
  `;
});
