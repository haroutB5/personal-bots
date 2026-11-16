// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import { HELD_UPSTREAM_MIGRATIONS, UPSTREAM_MIGRATION_IDS } from "../upstreamMigrationIds.ts";

const FILE = "063_DropUnusedV1Projections";
const DROPPED = [
  "projection_thread_activities",
  "projection_turns",
  "projection_thread_proposed_plans",
  "projection_pending_approvals",
  "projection_state",
  "checkpoint_diff_blobs",
] as const;
const KEPT = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_pull_requests",
] as const;

const BACKUP_CHECK = NodePath.join(
  import.meta.dirname,
  "../../../../../scripts/personal/linux/hbots-release/lib/dbcheck.mjs",
);

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("063_DropUnusedV1Projections", (it) => {
  it.effect("is released under the next fork id and no longer held", () =>
    Effect.sync(() => {
      const id = UPSTREAM_MIGRATION_IDS[FILE];
      assert.strictEqual(id, 160);
      assert.notInclude(HELD_UPSTREAM_MIGRATIONS, FILE);
      assert.deepStrictEqual(
        migrationManifest.find(([migrationId]) => migrationId === id),
        [160, "DropUnusedV1Projections"],
      );
      assert.strictEqual(Math.max(...migrationManifest.map(([migrationId]) => migrationId)), id);
    }),
  );

  it.effect("a full migration run drops the six V1 tables and keeps the import sources", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 159 });
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-1', 'thread-1', 'user', 'hello', 0, '2026-01-01', '2026-01-01')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        VALUES ('activity-1', 'thread-1', NULL, 'info', 'tool.completed', 'done', '{}', '2026-01-01')
      `;
      const before = yield* tableNames;
      for (const name of [...DROPPED, ...KEPT]) assert.isTrue(before.has(name), `before ${name}`);

      const applied = yield* runMigrations();

      assert.deepStrictEqual(
        applied.map(([migrationId]) => migrationId),
        [160],
      );
      const after = yield* tableNames;
      for (const name of DROPPED) assert.isFalse(after.has(name), name);
      for (const name of KEPT) assert.isTrue(after.has(name), name);
      const counted = /CHAT_ROWS_SQL = "SELECT count\(\*\) n FROM (\w+)"/.exec(
        NodeFS.readFileSync(BACKUP_CHECK, "utf8"),
      )?.[1];
      assert.isDefined(counted);
      assert.isTrue(after.has(counted!), `backup check counts ${counted}`);
      assert.deepEqual(yield* sql`SELECT message_id FROM projection_thread_messages`, [
        { message_id: "message-1" },
      ]);
    }),
  );
});

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  return new Set(rows.map((row) => row.name));
});
