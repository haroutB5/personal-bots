import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * How a saved key reaches a bot. `env` is what every key did until now: the
 * value is a PB_SECRET_<NAME> variable in the bot's provider sessions.
 * `brokered` keeps the value on the server: a bot can only name it in a
 * `secret_request` call, which injects it for the bound HTTPS origins and
 * never returns it. `origins_json` holds those origins (for a pending request
 * it is the origin the bot asked for, before the owner confirms it).
 *
 * Additive only. Every row that exists is `env` with no origins, so nothing a
 * bot can do today changes until the owner moves a key to brokered.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_secret_requests
    ADD COLUMN mode TEXT NOT NULL DEFAULT 'env'
  `;
  yield* sql`
    ALTER TABLE personal_secret_requests
    ADD COLUMN origins_json TEXT NOT NULL DEFAULT '[]'
  `;
});
