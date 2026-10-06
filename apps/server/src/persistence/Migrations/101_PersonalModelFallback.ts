import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Usage-limit model fallback (1.65.0). Additive only.
 *
 * - `personal_bots.fallback_enabled`: the bot form's switch. 1 for every bot
 *   that exists and every new one (the default is on).
 * - `personal_bots.fallback_model_json`: the model to switch to. NULL means the
 *   default (Claude Sonnet 5.5, effort high, 1M context window).
 * - `personal_bot_fallbacks`: one row per bot that runs on its fallback right
 *   now (a row exists = active; it is deleted when the bot switches back), so a
 *   restart keeps the switch. `reset_at` NULL means the provider did not report
 *   a reset and the switch back is decided by a re-check.
 * - `personal_chat_resumes.fallback`: 1 for a continue that runs on the fallback
 *   model straight away instead of waiting for the reset.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_bots ADD COLUMN fallback_enabled INTEGER NOT NULL DEFAULT 1`;
  yield* sql`ALTER TABLE personal_bots ADD COLUMN fallback_model_json TEXT`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_bot_fallbacks (
      bot_id TEXT PRIMARY KEY,
      fallback_model_json TEXT NOT NULL,
      from_instance_id TEXT NOT NULL,
      from_provider TEXT NOT NULL,
      reason TEXT,
      started_at TEXT NOT NULL,
      reset_at TEXT,
      notice_thread_id TEXT
    )
  `;
  yield* sql`ALTER TABLE personal_chat_resumes ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0`;
});
