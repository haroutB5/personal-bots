import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What team leads did to the bots on their teams (create_bot, update_bot,
 * remove_bot): the audit trail, and what the per-lead daily create limit
 * counts. Additive; nothing else reads or changes it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_lead_bot_actions (
      action_id TEXT PRIMARY KEY,
      lead_bot_id TEXT NOT NULL,
      lead_name TEXT NOT NULL,
      team TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'update', 'remove')),
      target_bot_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      changed_fields_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_personal_lead_bot_actions_lead
    ON personal_lead_bot_actions (lead_bot_id, action, created_at)
  `;
});
