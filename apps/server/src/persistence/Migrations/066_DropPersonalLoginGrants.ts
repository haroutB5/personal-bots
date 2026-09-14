import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-bot grants on saved logins are gone (user decision, 2026-09-14): every
 * bot may use every saved login.
 *
 * The grant rows described an isolation the runtime never had — the bots share
 * one browser profile, one cookie jar and one computer account — so keeping
 * them would only have kept the claim alive. What still gates a fill is the
 * exact origin and the browser-side protections around it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_personal_login_grants_bot`;
  yield* sql`DROP TABLE IF EXISTS personal_login_grants`;
});
