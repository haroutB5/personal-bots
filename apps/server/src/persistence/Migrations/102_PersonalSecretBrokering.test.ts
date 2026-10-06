import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("102_PersonalSecretBrokering", (it) => {
  it.effect("every saved key stays in env mode with no origins", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 101 });
      yield* sql`
        INSERT INTO personal_secret_requests (
          request_id, root_task_id, task_id, thread_id, bot_id, name, label, purpose,
          status, shared, created_at, fulfilled_at
        )
        VALUES
          ('r1', NULL, NULL, 'owner-saved', 'owner-saved', 'VERCEL_TOKEN', 'Vercel', 'Saved', 'fulfilled', 1,
           '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
          ('r2', 't', 't', 'th', 'bot-a', 'GITHUB_TOKEN', 'GitHub', 'Push', 'pending', 0,
           '2026-10-05T00:00:00.000Z', NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 102 });
      const rows = yield* sql<{
        readonly requestId: string;
        readonly mode: string;
        readonly origins: string;
      }>`
        SELECT request_id AS "requestId", mode AS "mode", origins_json AS "origins"
        FROM personal_secret_requests ORDER BY request_id
      `;
      assert.deepEqual(rows, [
        { requestId: "r1", mode: "env", origins: "[]" },
        { requestId: "r2", mode: "env", origins: "[]" },
      ]);
    }),
  );

  it.effect("running it again on a migrated database changes nothing", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 102 });
    }),
  );
});
