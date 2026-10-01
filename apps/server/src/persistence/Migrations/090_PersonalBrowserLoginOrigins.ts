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
 * A profile that already used a login does not know where. Every origin that
 * has a saved login or a login request is taken as used, the conservative
 * answer. With none to go on, the column stays NULL, which the browser reads
 * as "unknown" and keeps page scripts disabled everywhere, as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_browser_protection ADD COLUMN login_origins TEXT`;

  yield* sql`
    UPDATE personal_browser_protection
    SET login_origins = (
      SELECT json_group_array(origin)
      FROM (
        SELECT origin FROM personal_logins
        UNION
        SELECT origin FROM personal_login_requests
      )
    )
    WHERE login_used = 1
      AND EXISTS (
        SELECT 1 FROM personal_logins
        UNION ALL
        SELECT 1 FROM personal_login_requests
      )
  `;
});
