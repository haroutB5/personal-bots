import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("108_PersonalBotModelSchedule", (it) => {
  it.effect("adds schedule_json at 108, empty for bots that already exist, safe to run twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 107 });
      yield* sql`
          INSERT INTO personal_bots (
            bot_id, name, description, instructions, avatar_shape, avatar_color,
            model_selection_json, enabled, sort_order, created_at, updated_at, deleted_at
          )
          VALUES (
            'cfo', 'CFO', '', '', 'blob', '#1A73E8',
            '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1, 0,
            '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', NULL
          )
        `;

      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* runMigrations({ toMigrationInclusive: 108 });
      const rows = yield* sql<{ readonly schedule: string | null; readonly fallback: number }>`
          SELECT schedule_json AS "schedule", fallback_enabled AS "fallback"
          FROM personal_bots WHERE bot_id = 'cfo'
        `;
      // The bot is untouched: no schedule, usage-limit fallback still on.
      assert.deepEqual(rows, [{ schedule: null, fallback: 1 }]);

      const stored = `{"enabled":true,"from":"22:00","to":"07:00","modelSelection":{"instanceId":"claudeAgent","model":"claude-sonnet-5-5"}}`;
      yield* sql`UPDATE personal_bots SET schedule_json = ${stored} WHERE bot_id = 'cfo'`;
      const saved = yield* sql<{ readonly schedule: string | null }>`
          SELECT schedule_json AS "schedule" FROM personal_bots WHERE bot_id = 'cfo'
        `;
      assert.deepEqual(saved, [{ schedule: stored }]);
    }),
  );
});
