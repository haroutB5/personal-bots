import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "088_PersonalLeadBotConfirmations",
  (it) => {
    it.effect("adds the confirmation, team-move and restore tables without touching 087", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 87 });
        // A row written before this migration keeps working and gains a null link.
        yield* sql`
          INSERT INTO personal_lead_bot_actions (
            action_id, lead_bot_id, lead_name, team, action, target_bot_id, target_name,
            changed_fields_json, summary, thread_id, created_at
          ) VALUES (
            'old', 'bot-cfo', 'CFO', 'Finance', 'create', 'bot-tax', 'Tax',
            '[]', 'CFO created bot ''Tax''', 'thread-cfo', '2026-09-29T15:00:00.000Z'
          )
        `;
        yield* runMigrations({ toMigrationInclusive: 88 });
        const old = yield* sql`
          SELECT action_id, confirmation_id FROM personal_lead_bot_actions
        `;
        assert.deepEqual(old, [{ action_id: "old", confirmation_id: null }]);

        const insert = (id: string, action: string, status: string) =>
          sql`
            INSERT INTO personal_lead_bot_confirmations (
              confirmation_id, lead_bot_id, lead_name, team, action, target_bot_id, target_name,
              thread_id, payload_json, change_hash, base_json, lines_json, status,
              created_at, expires_at
            ) VALUES (
              ${id}, 'bot-cfo', 'CFO', 'Finance', ${action}, 'bot-analyst', 'Analyst',
              'thread-cfo', '{}', 'hash', '{}', '[]', ${status},
              '2026-09-29T15:00:00.000Z', '2026-09-29T15:15:00.000Z'
            )
          `;
        yield* insert("c1", "update", "pending");
        yield* insert("c2", "remove", "declined");
        // Only update and remove need a card; the statuses are a closed set.
        assert.equal((yield* Effect.result(insert("c3", "create", "pending")))._tag, "Failure");
        assert.equal((yield* Effect.result(insert("c4", "update", "maybe")))._tag, "Failure");
        assert.equal((yield* Effect.result(insert("c1", "update", "pending")))._tag, "Failure");
      }),
    );
  },
);
