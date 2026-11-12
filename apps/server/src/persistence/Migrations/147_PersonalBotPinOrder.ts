import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The pinned strip's saved order. `sort_order` already means a bot's place in
 * teams, files and provider lists, so pins get their own column:
 * `pin_order IS NOT NULL` exactly when `pinned = 1`. Existing pins keep their
 * current list order, numbered from zero.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE personal_bots ADD COLUMN pin_order INTEGER
  `;
  yield* sql`
    UPDATE personal_bots
    SET pin_order = (
      SELECT ranked.pin_order
      FROM (
        SELECT bot_id, ROW_NUMBER() OVER (ORDER BY sort_order, bot_id) - 1 AS pin_order
        FROM personal_bots
        WHERE pinned = 1
      ) AS ranked
      WHERE ranked.bot_id = personal_bots.bot_id
    )
    WHERE pinned = 1
  `;
});
