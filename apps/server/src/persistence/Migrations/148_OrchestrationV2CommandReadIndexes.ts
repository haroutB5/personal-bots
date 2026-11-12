import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Indexes for the three reads every command transaction makes. The nodes
 * index predicate must match ProjectionStore's open-node arm verbatim.
 * Additive only, no data change. Older binaries ignore the indexes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_type_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id, type, ordinal, turn_item_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_messages_thread_role_created_idx
    ON orchestration_v2_projection_messages(thread_id, role, created_at, message_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_nodes_thread_open_idx
    ON orchestration_v2_projection_nodes(thread_id, run_id)
    WHERE NOT (kind IN ('tool_call','assistant_message','reasoning') AND status IN ('completed','interrupted','failed','cancelled','rolled_back') AND run_id IS NOT NULL)
  `;
});
