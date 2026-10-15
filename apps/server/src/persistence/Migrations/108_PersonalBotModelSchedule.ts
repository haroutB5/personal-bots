import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Per-bot model schedule ("Use a different model at set times"). Additive only.
 *
 * - `personal_bots.schedule_json`: the schedule as JSON
 *   (`{"enabled":true,"from":"22:00","to":"07:00","modelSelection":{...}}`).
 *   NULL means no schedule, which every bot that exists and every new one gets.
 *
 * While a bot's daily window is open it runs on a row in
 * `personal_bot_fallbacks` with the reason `schedule` (the table and the usage
 * limit and DeepSeek peak switches that already use it are unchanged).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_bots ADD COLUMN schedule_json TEXT`;
});
