import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("084_PersonalChatResumes", (it) => {
  it.effect("adds the resume table at 84: one row per limit hit, known statuses only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 84 });
      yield* sql`
        INSERT INTO personal_chat_resumes (resume_id, thread_id, hit_key, provider, hit_at, status)
        VALUES ('r1', 't1', 'turn-1', 'claudeAgent', '2026-09-28T20:00:00.000Z', 'scheduled')
      `;
      const duplicate = yield* Effect.result(
        sql`
          INSERT INTO personal_chat_resumes (resume_id, thread_id, hit_key, provider, hit_at, status)
          VALUES ('r2', 't1', 'turn-1', 'claudeAgent', '2026-09-28T20:00:01.000Z', 'scheduled')
        `,
      );
      assert.equal(duplicate._tag, "Failure");
      const badStatus = yield* Effect.result(
        sql`UPDATE personal_chat_resumes SET status = 'later' WHERE resume_id = 'r1'`,
      );
      assert.equal(badStatus._tag, "Failure");
      const rows = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM personal_chat_resumes
      `;
      assert.deepEqual(rows, [{ n: 1 }]);
    }),
  );
});
