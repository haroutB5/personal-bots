import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "080_PersonalBotNotificationMute",
  (it) => {
    it.effect("adds notifications_muted_until at 80, on (NULL) for bots that already exist", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        yield* sql`
        INSERT INTO personal_bots (
          bot_id, name, description, instructions, avatar_shape, avatar_color,
          model_selection_json, enabled, sort_order, created_at, updated_at, deleted_at
        )
        VALUES (
          'cfo', 'CFO', '', '', 'blob', '#1A73E8',
          '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1, 0,
          '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', NULL
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 80 });
        const rows = yield* sql<{ readonly mutedUntil: string | null }>`
        SELECT notifications_muted_until AS "mutedUntil" FROM personal_bots WHERE bot_id = 'cfo'
      `;
        assert.deepEqual(rows, [{ mutedUntil: null }]);

        yield* sql`
        UPDATE personal_bots SET notifications_muted_until = '9999-12-31T23:59:59.000Z'
        WHERE bot_id = 'cfo'
      `;
        const muted = yield* sql<{ readonly mutedUntil: string | null }>`
        SELECT notifications_muted_until AS "mutedUntil" FROM personal_bots WHERE bot_id = 'cfo'
      `;
        assert.deepEqual(muted, [{ mutedUntil: "9999-12-31T23:59:59.000Z" }]);
      }),
    );
  },
);
