// @effect-diagnostics preferSchemaOverJson:off - stringifies EXPLAIN QUERY PLAN rows for one contains check
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "105_ProjectionThreadMessagesRoleIndex",
  (it) => {
    it.effect("adds the role-covering index and runs twice safely", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 104 });
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('message-1', 'thread-1', 'user', 'hello', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;

        yield* runMigrations({ toMigrationInclusive: 105 });
        yield* runMigrations({ toMigrationInclusive: 105 });

        const indexes = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'projection_thread_messages'
            AND name = 'idx_projection_thread_messages_thread_role_created_id'
        `;
        expect(indexes).toHaveLength(1);

        // The query the index exists for still answers, and the statement plan
        // picks the index up rather than the old created_at-first one.
        const newest = yield* sql<{ readonly newest: string | null }>`
          SELECT max(created_at) AS newest
          FROM projection_thread_messages
          WHERE thread_id = 'thread-1' AND role = 'user'
        `;
        expect(newest[0]?.newest).toBe("2026-01-01T00:00:00.000Z");
        const plan = yield* sql<Record<string, unknown>>`
          EXPLAIN QUERY PLAN
          SELECT max(created_at) FROM projection_thread_messages
          WHERE thread_id = 'thread-1' AND role = 'user'
        `;
        expect(JSON.stringify(plan)).toContain(
          "idx_projection_thread_messages_thread_role_created_id",
        );
      }),
    );
  },
);
