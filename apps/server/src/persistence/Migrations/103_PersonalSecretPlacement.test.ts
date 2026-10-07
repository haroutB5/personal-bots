import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("103_PersonalSecretPlacement", (it) => {
  it.effect("every saved key keeps the strictest placement (Authorization header only)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 102 });
      yield* sql`
        INSERT INTO personal_secret_requests (
          request_id, root_task_id, task_id, thread_id, bot_id, name, label, purpose,
          status, shared, mode, origins_json, created_at, fulfilled_at
        )
        VALUES
          ('r1', NULL, NULL, 'owner-saved', 'owner-saved', 'VERCEL_TOKEN', 'Vercel', 'Saved', 'fulfilled', 1,
           'brokered', '["https://api.vercel.com"]', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
          ('r2', 't', 't', 'th', 'bot-a', 'GITHUB_TOKEN', 'GitHub', 'Push', 'pending', 0,
           'env', '[]', '2026-10-05T00:00:00.000Z', NULL)
      `;

      yield* runMigrations({ toMigrationInclusive: 103 });
      const rows = yield* sql<{
        readonly requestId: string;
        readonly mode: string;
        readonly origins: string;
        readonly placement: string;
      }>`
        SELECT request_id AS "requestId", mode AS "mode", origins_json AS "origins",
               placement_json AS "placement"
        FROM personal_secret_requests ORDER BY request_id
      `;
      assert.deepEqual(rows, [
        {
          requestId: "r1",
          mode: "brokered",
          origins: '["https://api.vercel.com"]',
          placement: "{}",
        },
        { requestId: "r2", mode: "env", origins: "[]", placement: "{}" },
      ]);
    }),
  );

  it.effect("running it again on a migrated database changes nothing", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 103 });
    }),
  );
});
