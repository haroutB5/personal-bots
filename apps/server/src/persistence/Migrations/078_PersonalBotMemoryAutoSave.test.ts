import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "078_PersonalBotMemoryAutoSave",
  (it) => {
    it.effect("adds memory_auto_save at 78, off for bots that already exist", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 77 });
        yield* sql`
        INSERT INTO personal_bots (
          bot_id, name, description, instructions, avatar_shape, avatar_color,
          model_selection_json, enabled, sort_order, created_at, updated_at, deleted_at
        )
        VALUES (
          'cfo', 'CFO', '', '', 'blob', '#1A73E8',
          '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1, 0,
          '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z', NULL
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 78 });
        const rows = yield* sql<{ readonly memoryAutoSave: number }>`
        SELECT memory_auto_save AS "memoryAutoSave" FROM personal_bots WHERE bot_id = 'cfo'
      `;
        assert.deepEqual(rows, [{ memoryAutoSave: 0 }]);
      }),
    );
  },
);
