import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const refuses = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.equal(result._tag, "Failure");
  });

const insertRun = (values: string) => `INSERT INTO personal_create_app_runs (
  run_id, bot_id, thread_id, task_id, plan_json, plan_digest, approval_id,
  status, app_url, created_at, updated_at
) VALUES (${values})`;

const RUN_ONE = `'run-1', 'bot-1', 'thread-1', NULL, '{}', 'digest-1', NULL,
  'awaiting_approval', NULL, '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z'`;

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("074_PersonalCreateAppRuns", (it) => {
  it.effect("creates the run and step tables only at migration 74", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'personal_create_app%' ORDER BY name
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 74 });
      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'personal_create_app%' ORDER BY name
      `;
      assert.deepEqual(after, [
        { name: "personal_create_app_runs" },
        { name: "personal_create_app_steps" },
      ]);
    }),
  );

  it.effect("keeps one run per plan per chat, so an unchanged plan resumes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* sql.unsafe(insertRun(RUN_ONE));
      // The same plan asked for again is the same run. Enforced here so a
      // second caller cannot race a read-then-write into a duplicate.
      yield* refuses(sql.unsafe(insertRun(RUN_ONE.replace("'run-1'", "'run-2'"))));
      // A different plan in the same chat is a different run, and a decision.
      yield* sql.unsafe(
        insertRun(RUN_ONE.replace("'run-1'", "'run-3'").replace("'digest-1'", "'digest-2'")),
      );
    }),
  );

  it.effect("refuses a run status or a step state the runner cannot read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* sql.unsafe(
        insertRun(RUN_ONE.replace("'run-1'", "'run-5'").replace("'digest-1'", "'digest-5'")),
      );
      yield* refuses(
        sql.unsafe(
          insertRun(
            RUN_ONE.replace("'run-1'", "'run-4'")
              .replace("'digest-1'", "'digest-4'")
              .replace("'awaiting_approval'", "'nearly_done'"),
          ),
        ),
      );

      yield* sql`
        INSERT INTO personal_create_app_steps (run_id, step_id, title, position, state)
        VALUES ('run-5', 'github.repository', 'Create the repository', 0, 'pending')
      `;
      yield* refuses(sql`
        UPDATE personal_create_app_steps SET state = 'probably_done' WHERE run_id = 'run-5'
      `);
      // A step is either adopted from a reconcile or it is not; there is no
      // third answer, and "maybe" is exactly what must not be storable.
      yield* refuses(sql`
        UPDATE personal_create_app_steps SET adopted = 2 WHERE run_id = 'run-5'
      `);
    }),
  );
});
