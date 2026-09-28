import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "085_PersonalTaskChatAutoArchive",
  (it) => {
    it.effect(
      "adds last_viewed_at and auto_archived_at to bot chats, empty for existing rows",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 84 });
          yield* sql`
        INSERT INTO personal_bots (bot_id, name, description, instructions, avatar_shape, avatar_color, model_selection_json, enabled, sort_order, created_at, updated_at)
        VALUES ('b1', 'Bot', '', '', 'blob', '#000000', '{}', 1, 0, '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')
      `;
          yield* sql`
        INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
        VALUES ('t1', 'b1', '2026-09-28T00:00:00.000Z')
      `;
          yield* runMigrations({ toMigrationInclusive: 85 });
          const rows = yield* sql<{
            readonly lastViewedAt: string | null;
            readonly autoArchivedAt: string | null;
          }>`
        SELECT last_viewed_at AS "lastViewedAt", auto_archived_at AS "autoArchivedAt"
        FROM personal_bot_threads
      `;
          assert.deepEqual(rows, [{ lastViewedAt: null, autoArchivedAt: null }]);
        }),
    );
  },
);
