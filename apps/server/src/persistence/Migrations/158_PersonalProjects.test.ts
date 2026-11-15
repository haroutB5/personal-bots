import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-14T10:00:00.000Z";

const insertProject = (input: {
  readonly projectId: string;
  readonly name: string;
  readonly state: string;
  readonly closedAt: string | null;
  readonly dueAt: string | null;
  readonly estimatedAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_projects (
        project_id, lead_bot_id, thread_id, name, steps_json, due_at, estimated_at,
        state, closed_at, created_at, updated_at
      )
      VALUES (
        ${input.projectId}, 'lead', NULL, ${input.name}, '[{"label":"Build","state":"doing"}]',
        ${input.dueAt}, ${input.estimatedAt}, ${input.state}, ${input.closedAt}, ${AT}, ${AT}
      )
    `;
  });

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => String((error as { reason?: { _tag?: string } }).reason?._tag ?? error),
      onSuccess: () => "inserted",
    }),
  );

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("158_PersonalProjects", (it) => {
  it.effect("keeps existing tasks and gives them no project", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 157 });
      yield* sql`
        INSERT INTO personal_tasks (
          task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
          depth, max_depth, max_children, created_at, updated_at
        )
        VALUES ('t1', 't1', 'bot', 'Task', 'Do it.', 'running', 'user', 'k1',
                0, 3, 4, ${AT}, ${AT})
      `;

      yield* runMigrations({ toMigrationInclusive: 158 });

      const rows = yield* sql<{ readonly taskId: string; readonly projectId: string | null }>`
        SELECT task_id AS "taskId", project_id AS "projectId" FROM personal_tasks
      `;
      assert.deepStrictEqual(rows, [{ taskId: "t1", projectId: null }]);
    }),
  );

  it.effect(
    "rejects a closed state without closedAt and a due time without its estimate time",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 158 });

        const doneWithoutClosedAt = yield* failureOf(
          insertProject({
            projectId: "p1",
            name: "Done early",
            state: "done",
            closedAt: null,
            dueAt: null,
            estimatedAt: null,
          }),
        );
        const openWithClosedAt = yield* failureOf(
          insertProject({
            projectId: "p2",
            name: "Open late",
            state: "open",
            closedAt: AT,
            dueAt: null,
            estimatedAt: null,
          }),
        );
        const dueWithoutEstimate = yield* failureOf(
          insertProject({
            projectId: "p3",
            name: "Half estimate",
            state: "open",
            closedAt: null,
            dueAt: AT,
            estimatedAt: null,
          }),
        );
        const valid = yield* failureOf(
          insertProject({
            projectId: "p4",
            name: "Matchday optimisation",
            state: "open",
            closedAt: null,
            dueAt: AT,
            estimatedAt: AT,
          }),
        );

        assert.match(doneWithoutClosedAt, /ConstraintError/);
        assert.match(openWithClosedAt, /ConstraintError/);
        assert.match(dueWithoutEstimate, /ConstraintError/);
        assert.strictEqual(valid, "inserted");
      }),
  );

  it.effect("allows one open project per lead and name, and reuses a closed name", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 158 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM personal_projects WHERE lead_bot_id = 'lead'`;

      yield* insertProject({
        projectId: "a",
        name: "CalTrack port",
        state: "open",
        closedAt: null,
        dueAt: null,
        estimatedAt: null,
      });
      const twin = yield* failureOf(
        insertProject({
          projectId: "b",
          name: "caltrack PORT",
          state: "open",
          closedAt: null,
          dueAt: null,
          estimatedAt: null,
        }),
      );
      yield* sql`UPDATE personal_projects SET state = 'done', closed_at = ${AT} WHERE project_id = 'a'`;
      const reused = yield* failureOf(
        insertProject({
          projectId: "c",
          name: "CalTrack port",
          state: "open",
          closedAt: null,
          dueAt: null,
          estimatedAt: null,
        }),
      );

      assert.match(twin, /UniqueViolation/);
      assert.strictEqual(reused, "inserted");
    }),
  );
});
