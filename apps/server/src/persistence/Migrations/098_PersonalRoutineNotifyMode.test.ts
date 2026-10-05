import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "098_PersonalRoutineNotifyMode",
  (it) => {
    it.effect("existing routines keep 'always' and existing tasks have no decision", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 97 });
        yield* sql`
        INSERT INTO personal_routines (
          routine_id, bot_id, title, prompt, schedule_json, created_at, updated_at
        )
        VALUES ('r1', 'bot', 'Report', 'Report.', 'null', '2026-10-05T00:00:00.000Z',
                '2026-10-05T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO personal_tasks (
          task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
          depth, max_depth, max_children, created_at, updated_at
        )
        VALUES ('t1', 't1', 'bot', 'Task', 'Do it.', 'completed', 'routine', 'k1',
                0, 3, 4, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')
      `;

        yield* runMigrations({ toMigrationInclusive: 98 });
        const routines = yield* sql<{ readonly notifyMode: string }>`
        SELECT notify_mode AS "notifyMode" FROM personal_routines WHERE routine_id = 'r1'
      `;
        assert.deepEqual(routines, [{ notifyMode: "always" }]);
        const tasks = yield* sql<{
          readonly mode: string | null;
          readonly decision: number | null;
          readonly message: string | null;
        }>`
        SELECT notify_mode AS "mode", notify_decision AS "decision", notify_message AS "message"
        FROM personal_tasks WHERE task_id = 't1'
      `;
        assert.deepEqual(tasks, [{ mode: null, decision: null, message: null }]);

        yield* sql`UPDATE personal_routines SET notify_mode = 'bot_decides' WHERE routine_id = 'r1'`;
        const refused = yield* Effect.result(
          sql`UPDATE personal_routines SET notify_mode = 'sometimes' WHERE routine_id = 'r1'`,
        );
        assert.equal(refused._tag, "Failure");
      }),
    );
  },
);
