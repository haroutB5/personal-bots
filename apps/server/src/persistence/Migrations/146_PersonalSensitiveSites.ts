import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Sites the owner treats as sensitive although hbots holds no login for them,
 * such as the ones read from an imported browser. They join the flagged logins
 * wherever sensitive sites are listed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_sensitive_sites (
      origin TEXT NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY (origin, label)
    )
  `;
});
