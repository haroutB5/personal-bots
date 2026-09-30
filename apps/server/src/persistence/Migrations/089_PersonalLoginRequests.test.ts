import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("089_PersonalLoginRequests", (it) => {
  it.effect(
    "keeps saved logins intact and creates request metadata without credential columns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 88 });
        yield* sql`INSERT INTO personal_logins
        (login_id, label, origin, username, secret_ref, sensitive, created_at, updated_at)
        VALUES ('fixture', 'Fixture', 'https://example.com', 'fixture-user', 'encrypted-ref', 1,
          '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z')`;
        const before = yield* sql`SELECT * FROM personal_logins WHERE login_id = 'fixture'`;
        yield* runMigrations({ toMigrationInclusive: 89 });
        assert.deepEqual(
          yield* sql`SELECT * FROM personal_logins WHERE login_id = 'fixture'`,
          before,
        );
        const columns = yield* sql<{ name: string }>`PRAGMA table_info(personal_login_requests)`;
        assert.strictEqual(
          columns.some((column) => /username|password|value|credential|secret/.test(column.name)),
          false,
        );
      }),
  );
});
