import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
