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

    it.effect("records every team change of a bot, whichever path made it", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM personal_bot_team_moves
        `;
        assert.equal(before[0]?.n, 0);
        yield* sql`
          INSERT INTO personal_bots (
            bot_id, name, description, instructions, avatar_shape, avatar_color,
            model_selection_json, enabled, sort_order, team, is_lead, pinned,
            created_at, updated_at
          ) VALUES (
            'bot-a', 'Alpha', '', '', 'blob', '#1A73E8',
            '{"instanceId":"claudeAgent","model":"m"}', 1, 0, 'Finance', 0, 0,
            '2026-09-29T15:00:00.000Z', '2026-09-29T15:00:00.000Z'
          )
        `;
        // Creating a bot is not a move; changing anything but the team is not either.
        yield* sql`UPDATE personal_bots SET name = 'Alpha2' WHERE bot_id = 'bot-a'`;
        yield* sql`UPDATE personal_bots SET team = 'Finance' WHERE bot_id = 'bot-a'`;
        assert.deepEqual(yield* sql`SELECT count(*) AS n FROM personal_bot_team_moves`, [{ n: 0 }]);
        yield* sql`UPDATE personal_bots SET team = 'dev' WHERE bot_id = 'bot-a'`;
        yield* sql`UPDATE personal_bots SET team = 'Finance' WHERE bot_id = 'bot-a'`;
        const moves = yield* sql`
          SELECT bot_id, from_team, to_team FROM personal_bot_team_moves ORDER BY move_id
        `;
        assert.deepEqual(moves, [
          { bot_id: "bot-a", from_team: "Finance", to_team: "dev" },
          { bot_id: "bot-a", from_team: "dev", to_team: "Finance" },
        ]);
        const stamp = yield* sql<{ readonly moved_at: string }>`
          SELECT moved_at FROM personal_bot_team_moves LIMIT 1
        `;
        // Same shape as the app's own timestamps, so the two compare as text.
        assert.match(stamp[0]!.moved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }),
    );
  },
);
