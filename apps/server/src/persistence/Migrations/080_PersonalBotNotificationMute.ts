import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A per-bot notification mute. NULL means notifications are on (every bot that
 * already exists, and every new one); a time means muted until then, and a
 * far-future time means muted until the owner turns it back on. The push
 * service reads it before a notification takes any path, in-app or web push.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_bots
    ADD COLUMN notifications_muted_until TEXT
  `;
});
