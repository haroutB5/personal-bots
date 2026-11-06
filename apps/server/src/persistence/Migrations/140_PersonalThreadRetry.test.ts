import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("140_PersonalThreadRetry", (it) => {
  it.effect("adds the retry marker and runs twice safely", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 139 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'personal_thread_retry'
      `;
      expect(before).toEqual([]);

      yield* runMigrations({ toMigrationInclusive: 140 });
      yield* runMigrations({ toMigrationInclusive: 140 });

      yield* sql`
        INSERT INTO personal_thread_retry
          (thread_id, attempt, max_attempts, retry_at, auto, provider, observed_at)
        VALUES ('thread-1', 2, 5, NULL, 'pending', 'claudeAgent',
          '2026-11-06T12:00:00.000Z')
      `;
      const rows = yield* sql<{ readonly attempt: number; readonly auto: string }>`
        SELECT attempt, auto FROM personal_thread_retry WHERE thread_id = 'thread-1'
      `;
      expect(rows).toEqual([{ attempt: 2, auto: "pending" }]);
    }),
  );
});
