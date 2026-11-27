import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Eco mode v1, additive: the bot form's Eco switch and builder model on
 * personal_bots (NULL builder = Sonnet 5.5 on the bot's instance), and
 * personal_eco_turns with each Eco turn's planner and builder usage.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_bots ADD COLUMN eco_enabled INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE personal_bots ADD COLUMN eco_model_json TEXT`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_eco_turns (
      eco_turn_id TEXT PRIMARY KEY,
      bot_id TEXT,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      planner_model TEXT NOT NULL,
      builder_model TEXT NOT NULL,
      handed_off INTEGER NOT NULL,
      eco_skipped TEXT,
      handoff_error TEXT,
      plan_markdown TEXT,
      status TEXT NOT NULL,
      planner_calls INTEGER NOT NULL,
      planner_input_tokens INTEGER NOT NULL,
      planner_output_tokens INTEGER NOT NULL,
      planner_cache_read_tokens INTEGER NOT NULL,
      planner_cache_write_tokens INTEGER NOT NULL,
      planner_cost_usd REAL,
      builder_calls INTEGER NOT NULL,
      builder_input_tokens INTEGER NOT NULL,
      builder_output_tokens INTEGER NOT NULL,
      builder_cache_read_tokens INTEGER NOT NULL,
      builder_cache_write_tokens INTEGER NOT NULL,
      builder_cost_usd REAL,
      sdk_cost_usd_json TEXT,
      calls_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      handed_off_at TEXT,
      completed_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS personal_eco_turns_bot_completed
    ON personal_eco_turns (bot_id, completed_at)
  `;
});
