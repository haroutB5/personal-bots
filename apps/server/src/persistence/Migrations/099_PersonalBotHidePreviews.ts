import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A per-bot privacy switch: when set, the bot's message text is not previewed
 * anywhere outside its own chat (lists, cards, cold-start cache, push and
 * banners show a neutral line). 0 means previews as before, which every bot
 * that already exists and every new one gets. Additive only.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_bots
    ADD COLUMN hide_previews INTEGER NOT NULL DEFAULT 0
  `;
});
