import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Browser credential protections, persisted beside `personal_browser_leases`.
 *
 * Chrome keeps its cookies in the persistent profile, so an authenticated
 * session survives both a Chrome close and a server restart. The protections
 * that gate that session were process memory only, so a restart left the
 * signed-in profile with no protection at all (audit finding #3). One row per
 * profile, rewritten whole: the state is a handful of origins.
 *
 * `login_used` disables page scripts everywhere; `credential_origins` records
 * the origins a saved login was filled into and which bot filled each one;
 * `tainted_origins` records origins where a model-provided script was allowed
 * to run, which blocks a later fill there because a service worker installed
 * then can outlive any tab (audit finding #2).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_browser_protection (
      profile_id TEXT PRIMARY KEY,
      login_used INTEGER NOT NULL DEFAULT 0,
      credential_origins TEXT NOT NULL DEFAULT '[]',
      tainted_origins TEXT NOT NULL DEFAULT '[]'
    )
  `;
});
