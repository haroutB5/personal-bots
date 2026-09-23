import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A per-bot standing permission to save memories without being asked.
 *
 * Off for every existing bot: save_memory keeps requiring the user's explicit
 * ask until the owner turns this on for a bot in its editor.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_bots
    ADD COLUMN memory_auto_save INTEGER NOT NULL DEFAULT 0
  `;
});
