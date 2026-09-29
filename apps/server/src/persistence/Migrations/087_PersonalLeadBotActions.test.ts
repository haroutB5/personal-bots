import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const insert = (sql: SqlClient.SqlClient, id: string, action: string) =>
  sql`
    INSERT INTO personal_lead_bot_actions (
      action_id, lead_bot_id, lead_name, team, action, target_bot_id, target_name,
      changed_fields_json, summary, thread_id, created_at
    )
    VALUES (
      ${id}, 'bot-cfo', 'CFO', 'Finance', ${action}, 'bot-tax', 'Tax',
      '[]', 'CFO created bot ''Tax''', 'thread-cfo', '2026-09-29T15:00:00.000Z'
    )
  `;

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("087_PersonalLeadBotActions", (it) => {
  it.effect("records create, update and remove, once per action id, and nothing else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });
      yield* insert(sql, "a1", "create");
      yield* insert(sql, "a2", "update");
      yield* insert(sql, "a3", "remove");
      assert.equal((yield* Effect.result(insert(sql, "a1", "create")))._tag, "Failure");
      assert.equal((yield* Effect.result(insert(sql, "a4", "promote")))._tag, "Failure");
      const rows = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM personal_lead_bot_actions
      `;
      assert.deepEqual(rows, [{ n: 3 }]);
      // Before and after values default to empty objects; the reason to null.
      const defaults = yield* sql`
        SELECT before_json, after_json, reason FROM personal_lead_bot_actions WHERE action_id = 'a1'
      `;
      assert.deepEqual(defaults, [{ before_json: "{}", after_json: "{}", reason: null }]);
      yield* sql`
        UPDATE personal_lead_bot_actions
        SET before_json = '{"title":"a"}', after_json = '{"title":"b"}', reason = 'merged'
        WHERE action_id = 'a3'
      `;
      const kept = yield* sql`
        SELECT before_json, after_json, reason FROM personal_lead_bot_actions WHERE action_id = 'a3'
      `;
      assert.deepEqual(kept, [
        { before_json: '{"title":"a"}', after_json: '{"title":"b"}', reason: "merged" },
      ]);
    }),
  );
});
