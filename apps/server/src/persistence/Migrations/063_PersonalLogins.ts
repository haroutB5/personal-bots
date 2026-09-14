import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Login metadata and grants only. Password bytes live exclusively in ServerSecretStore. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_logins (
      login_id TEXT PRIMARY KEY,
      label TEXT NOT NULL COLLATE NOCASE,
      origin TEXT NOT NULL,
      username TEXT NOT NULL,
      secret_ref TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_personal_logins_label
    ON personal_logins(label COLLATE NOCASE)
  `;

  yield* sql`
    CREATE INDEX idx_personal_logins_origin
    ON personal_logins(origin)
  `;

  yield* sql`
    CREATE TABLE personal_login_grants (
      login_id TEXT NOT NULL REFERENCES personal_logins(login_id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL REFERENCES personal_bots(bot_id),
      PRIMARY KEY (login_id, bot_id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_personal_login_grants_bot
    ON personal_login_grants(bot_id, login_id)
  `;
});
