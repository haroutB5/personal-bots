import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const insertBot = (input: {
  readonly botId: string;
  readonly sortOrder: number;
  readonly pinned: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, pinned, created_at, updated_at, deleted_at
      )
      VALUES (
        ${input.botId}, ${input.botId}, '', '', 'blob', '#1A73E8',
        '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1,
        ${input.sortOrder}, ${input.pinned},
        '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z', NULL
      )
    `;
  });

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("147_PersonalBotPinOrder", (it) => {
  it.effect("backfills pinned rows in list order and leaves unpinned rows NULL", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 146 });
      yield* insertBot({ botId: "third", sortOrder: 30, pinned: 1 });
      yield* insertBot({ botId: "first", sortOrder: 10, pinned: 1 });
      yield* insertBot({ botId: "unpinned", sortOrder: 20, pinned: 0 });
      yield* insertBot({ botId: "second", sortOrder: 20, pinned: 1 });

      yield* runMigrations({ toMigrationInclusive: 147 });

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly botId: string; readonly pinOrder: number | null }>`
        SELECT bot_id AS "botId", pin_order AS "pinOrder"
        FROM personal_bots
        ORDER BY bot_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { botId: "first", pinOrder: 0 },
        { botId: "second", pinOrder: 1 },
        { botId: "third", pinOrder: 2 },
        { botId: "unpinned", pinOrder: null },
      ]);
    }),
  );
});
