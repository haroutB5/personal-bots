// @effect-diagnostics preferSchemaOverJson:off - stringifies EXPLAIN QUERY PLAN rows for one contains check
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("107_FreezeLookupIndexes", (it) => {
  it.effect("adds both lookup indexes, runs twice safely and the lookups use them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 106 });
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-1', 'thread-1', 'assistant', 'hello', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               ('message-2', 'thread-1', 'system', 'note', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')`;

      yield* runMigrations({ toMigrationInclusive: 107 });
      yield* runMigrations({ toMigrationInclusive: 107 });

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_projection_thread_messages_thread_created_id_role',
            'idx_projection_threads_shell_latest_turn'
          )
        ORDER BY name
      `;
      expect(indexes.map((row) => row.name)).toEqual([
        "idx_projection_thread_messages_thread_created_id_role",
        "idx_projection_threads_shell_latest_turn",
      ]);

      // The bots list's newest non-system message: same answer, index only.
      const newest = yield* sql<{ readonly newest: string | null }>`
        SELECT max(created_at) AS newest FROM projection_thread_messages
        WHERE thread_id = 'thread-1' AND role NOT IN ('system', 'reasoning')
      `;
      expect(newest[0]?.newest).toBe("2026-01-01T00:00:00.000Z");
      const messagePlan = yield* sql<Record<string, unknown>>`
        EXPLAIN QUERY PLAN
        SELECT n.message_id FROM projection_thread_messages n
        WHERE n.thread_id = 'thread-1' AND n.role NOT IN ('system', 'reasoning')
        ORDER BY n.created_at DESC, n.message_id DESC
        LIMIT 1
      `;
      expect(JSON.stringify(messagePlan)).toContain(
        "COVERING INDEX idx_projection_thread_messages_thread_created_id_role",
      );

      // The shell snapshot's latest turns read the open threads from the index.
      const turnPlan = yield* sql<Record<string, unknown>>`
        EXPLAIN QUERY PLAN
        SELECT turns.turn_id FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `;
      expect(JSON.stringify(turnPlan)).toContain(
        "COVERING INDEX idx_projection_threads_shell_latest_turn",
      );
    }),
  );
});
