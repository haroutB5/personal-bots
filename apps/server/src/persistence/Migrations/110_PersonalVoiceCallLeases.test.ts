import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("110_PersonalVoiceCallLeases", (it) => {
  it.effect("adds the open-call table and leaves the card table alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 109 });

      const before = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS "count" FROM sqlite_master
          WHERE type = 'table' AND name = 'personal_voice_call_leases'
        `;
      assert.equal(Number(before[0]!.count), 0);

      yield* runMigrations({ toMigrationInclusive: 110 });
      // Running it again changes nothing: the migrator records what it applied.
      yield* runMigrations({ toMigrationInclusive: 110 });

      const columns = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_table_info('personal_voice_call_leases') ORDER BY cid
        `;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["call_id", "thread_id", "bot_id", "opened_at", "expires_at"],
      );

      // SQLite adds its own unique index for the TEXT primary key; the one
      // this migration creates is the expiry lookup the classifier is not
      // even using yet (it reads the whole table), kept for prunes.
      const indexes = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'personal_voice_call_leases'
            AND name NOT LIKE 'sqlite_autoindex%'
        `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        ["personal_voice_call_leases_expires_at"],
      );

      // The lease holds ids and timestamps only: no word said on a call can
      // reach it, and a card written without one still works.
      const leaseColumns = columns.map((column) => column.name);
      assert.notInclude(leaseColumns, "transcript_json");
      assert.notInclude(leaseColumns, "detail");
      const cards = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS "count" FROM personal_voice_calls
        `;
      assert.equal(Number(cards[0]!.count), 0);
    }),
  );
});
