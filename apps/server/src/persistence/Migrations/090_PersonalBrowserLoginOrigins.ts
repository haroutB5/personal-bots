import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Page scripts used to be disabled on every origin once any saved login had
 * been used in the shared profile. They are now disabled only on the sites a
 * login was used on, so the row records those origins.
 *
 * Additive: `login_used` stays as it was and is still written, so a rollback
 * to a release that only knows the flag keeps blocking everywhere.
 *
 * A profile that already used a login does not know where, and the saved
 * logins are not a complete history (a deleted login's session can still be
 * in the profile), so nothing is guessed: the column stays NULL, which keeps
 * page scripts disabled everywhere until an explicitly requested profile
 * reset (browserProfileReset.ts) replaces the profile.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_browser_protection ADD COLUMN login_origins TEXT`;
});
