import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("063_PersonalLogins", (it) => {
  it.effect("creates metadata and grant tables without any password column or default grant", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(personal_logins)`;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["login_id", "label", "origin", "username", "secret_ref", "created_at", "updated_at"],
      );
      assert.ok(columns.every((column) => !/password|secret_value/i.test(column.name)));

      yield* sql`
        INSERT INTO personal_logins (
          login_id, label, origin, username, secret_ref, created_at, updated_at
        ) VALUES (
          'login-1', 'Example', 'https://example.com', 'person@example.com', 'opaque-ref',
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z'
        )
      `;
      const grants = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM personal_login_grants WHERE login_id = 'login-1'
      `;
      assert.deepEqual(grants, [{ count: 0 }]);
    }),
  );
});
