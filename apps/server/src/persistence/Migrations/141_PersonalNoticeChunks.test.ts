import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("141_PersonalNoticeChunks", (it) => {
  it.effect("adds the chunk key and keeps one row per message and key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 140 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'personal_notice_chunks'
      `;
      expect(before).toEqual([]);

      yield* runMigrations({ toMigrationInclusive: 141 });
      yield* runMigrations({ toMigrationInclusive: 141 });

      yield* sql`INSERT INTO personal_notice_chunks (message_id, chunk_key) VALUES ('m-1', 'first')`;
      yield* sql`INSERT INTO personal_notice_chunks (message_id, chunk_key) VALUES ('m-1', 'first')
        ON CONFLICT(message_id, chunk_key) DO NOTHING`;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS "count" FROM personal_notice_chunks WHERE message_id = 'm-1'
      `;
      expect(rows[0]?.count).toBe(1);
    }),
  );
});
