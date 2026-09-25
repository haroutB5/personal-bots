import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("081_PersonalRoutineThread", (it) => {
  it.effect("adds the source chat at 81: existing routines keep NULL and a new chat per run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO personal_routines (
          routine_id, bot_id, title, prompt, schedule_json, created_at, updated_at
        )
        VALUES ('r1', 'bot', 'Report', 'Report.', 'null', '2026-09-25T00:00:00.000Z',
                '2026-09-25T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 81 });
      const rows = yield* sql<{
        readonly threadId: string | null;
        readonly newChatEachRun: number;
        readonly delivery: string;
      }>`
        SELECT thread_id AS "threadId", new_chat_each_run AS "newChatEachRun", delivery
        FROM personal_routines WHERE routine_id = 'r1'
      `;
      assert.deepEqual(rows, [{ threadId: null, newChatEachRun: 0, delivery: "model" }]);
      yield* sql`UPDATE personal_routines SET thread_id = 't1', new_chat_each_run = 1`;
      const refused = yield* Effect.result(
        sql`UPDATE personal_routines SET new_chat_each_run = 2 WHERE routine_id = 'r1'`,
      );
      assert.equal(refused._tag, "Failure");
    }),
  );
});
