import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("099_PersonalBotHidePreviews", (it) => {
  it.effect("adds hide_previews at 99, off (0) for bots that already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });
      yield* sql`
        INSERT INTO personal_bots (
          bot_id, name, description, instructions, avatar_shape, avatar_color,
          model_selection_json, enabled, sort_order, created_at, updated_at, deleted_at
        )
        VALUES (
          'cfo', 'CFO', '', '', 'blob', '#1A73E8',
          '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1, 0,
          '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 99 });
      const rows = yield* sql<{ readonly hidden: number }>`
        SELECT hide_previews AS "hidden" FROM personal_bots WHERE bot_id = 'cfo'
      `;
      assert.deepEqual(rows, [{ hidden: 0 }]);

      yield* sql`UPDATE personal_bots SET hide_previews = 1 WHERE bot_id = 'cfo'`;
      const hidden = yield* sql<{ readonly hidden: number }>`
        SELECT hide_previews AS "hidden" FROM personal_bots WHERE bot_id = 'cfo'
      `;
      assert.deepEqual(hidden, [{ hidden: 1 }]);
    }),
  );
});
