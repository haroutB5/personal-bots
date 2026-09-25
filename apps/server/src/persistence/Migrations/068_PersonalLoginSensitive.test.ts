import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("068_PersonalLoginSensitive", (it) => {
  it.effect("adds an off-by-default sensitive flag and keeps existing logins as they were", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Everything before this migration, upstream's 067 included once merged.
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`
        INSERT INTO personal_logins (
          login_id, label, origin, username, secret_ref, created_at, updated_at
        ) VALUES (
          'login-1', 'Bank', 'https://bank.example', 'person', 'opaque-ref',
          '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 68 });

      const rows = yield* sql<{ readonly label: string; readonly sensitive: number }>`
        SELECT label, sensitive FROM personal_logins
      `;
      assert.deepEqual(rows, [{ label: "Bank", sensitive: 0 }]);
    }),
  );
});
