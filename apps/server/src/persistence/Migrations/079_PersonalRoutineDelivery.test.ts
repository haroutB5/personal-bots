import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("079_PersonalRoutineDelivery", (it) => {
  it.effect("adds delivery at 79: existing routines keep the model, only known modes fit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`
        INSERT INTO personal_routines (
          routine_id, bot_id, title, prompt, schedule_json, created_at, updated_at
        )
        VALUES ('r1', 'bot', 'Report', 'Report.', 'null', '2026-09-23T00:00:00.000Z',
                '2026-09-23T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 79 });
      const rows = yield* sql<{ readonly delivery: string }>`
        SELECT delivery FROM personal_routines WHERE routine_id = 'r1'
      `;
      assert.deepEqual(rows, [{ delivery: "model" }]);
      yield* sql`UPDATE personal_routines SET delivery = 'relay' WHERE routine_id = 'r1'`;
      const refused = yield* Effect.result(
        sql`UPDATE personal_routines SET delivery = 'email' WHERE routine_id = 'r1'`,
      );
      assert.equal(refused._tag, "Failure");
    }),
  );
});
