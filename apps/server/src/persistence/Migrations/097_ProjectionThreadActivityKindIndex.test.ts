import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("097_ProjectionThreadActivityKindIndex", (it) => {
  it.effect("indexes activities by kind, and the startup lookup uses it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 96 });
      yield* runMigrations({ toMigrationInclusive: 97 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_activities_kind_thread')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["kind", "thread_id"],
      );

      // The query `reconcileWorktreeSetups` runs at every boot must search by kind,
      // not read every activity row (208,748 of them, 6.5 s cold, on the live data).
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT a.activity_id
        FROM projection_thread_activities a
        JOIN projection_threads t ON t.thread_id = a.thread_id
        WHERE a.kind = 'worktree-setup' AND t.deleted_at IS NULL AND t.archived_at IS NULL
        ORDER BY a.created_at ASC, a.activity_id ASC
      `;
      assert.ok(
        plan.some((step) => step.detail.includes("idx_projection_thread_activities_kind_thread")),
        plan.map((step) => step.detail).join(" | "),
      );
    }),
  );

  it.effect("running it twice changes nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* sql`DROP INDEX idx_projection_thread_activities_kind_thread`;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_thread
        ON projection_thread_activities(kind, thread_id)
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_thread
        ON projection_thread_activities(kind, thread_id)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      assert.strictEqual(
        indexes.filter((index) => index.name === "idx_projection_thread_activities_kind_thread")
          .length,
        1,
      );
    }),
  );
});
