import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Where a brokered key's `{{secret:NAME}}` placeholder may go, per saved key:
 * `{}` (the default) is the Authorization header only. The owner can add one
 * more header name, allow the URL and body, and narrow the key to a path
 * prefix and a method list (see `PersonalSecretPlacement` in contracts).
 *
 * Additive only. Every existing row gets `{}`, which is the strictest policy,
 * so nothing a key could do before 1.66.0 widens.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_secret_requests
    ADD COLUMN placement_json TEXT NOT NULL DEFAULT '{}'
  `;
});
