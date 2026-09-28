import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const insert = (sql: SqlClient.SqlClient, id: string, status: string, kind = "members") =>
  sql`
    INSERT INTO personal_group_limit_resumes (
      resume_id, group_id, round_id, kind, bot_ids_json, provider, hit_at, resume_at, status
    )
    VALUES (
      ${id}, 'g1', 'round-1', ${kind}, '["b1"]', 'claudeAgent',
      '2026-09-28T20:00:00.000Z', '2026-09-28T23:00:00.000Z', ${status}
    )
  `;

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "086_PersonalGroupLimitResumes",
  (it) => {
    it.effect("one scheduled row per round and kind; resolved rows do not block a new one", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 86 });
        yield* insert(sql, "r1", "scheduled");
        const duplicate = yield* Effect.result(insert(sql, "r2", "scheduled"));
        assert.equal(duplicate._tag, "Failure");
        // Another kind on the same round is its own hit.
        yield* insert(sql, "r3", "scheduled", "verdict");
        // Once resolved, a later hit on the same round may schedule again.
        yield* sql`UPDATE personal_group_limit_resumes SET status = 'resumed' WHERE resume_id = 'r1'`;
        yield* insert(sql, "r4", "scheduled");
        const badStatus = yield* Effect.result(
          sql`UPDATE personal_group_limit_resumes SET status = 'later' WHERE resume_id = 'r4'`,
        );
        assert.equal(badStatus._tag, "Failure");
        const badKind = yield* Effect.result(insert(sql, "r5", "scheduled", "everyone"));
        assert.equal(badKind._tag, "Failure");
        const rows = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM personal_group_limit_resumes
        `;
        assert.deepEqual(rows, [{ n: 3 }]);
      }),
    );
  },
);
