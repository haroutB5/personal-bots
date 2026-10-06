import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "100_PersonalChatPinSnoozeUnread",
  (it) => {
    it.effect(
      "adds nullable pin, snooze and mark columns; existing chats and groups keep null",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 99 });
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
          yield* sql`
          INSERT INTO personal_bot_threads (thread_id, bot_id, created_at, archived_at)
          VALUES ('thread-1', 'cfo', '2026-10-05T00:00:00.000Z', NULL)
        `;
          yield* sql`
          INSERT INTO personal_groups (
            group_id, name, description, thread_id, max_bot_turns, created_at, updated_at
          )
          VALUES ('g1', 'Group', '', 'thread-g1', 6, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')
        `;

          yield* runMigrations({ toMigrationInclusive: 100 });
          const threads = yield* sql<{
            readonly pinned: string | null;
            readonly snoozed: string | null;
            readonly marked: string | null;
          }>`
          SELECT pinned_at AS "pinned", snoozed_until AS "snoozed", marked_unread_at AS "marked"
          FROM personal_bot_threads WHERE thread_id = 'thread-1'
        `;
          assert.deepEqual(threads, [{ pinned: null, snoozed: null, marked: null }]);
          const groups = yield* sql<{
            readonly pinned: string | null;
            readonly snoozed: string | null;
          }>`
          SELECT pinned_at AS "pinned", snoozed_until AS "snoozed"
          FROM personal_groups WHERE group_id = 'g1'
        `;
          assert.deepEqual(groups, [{ pinned: null, snoozed: null }]);
        }),
    );
  },
);
