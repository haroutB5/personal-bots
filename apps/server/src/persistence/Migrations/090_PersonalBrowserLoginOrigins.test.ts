import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

interface Row {
  readonly profileId: string;
  readonly loginUsed: number;
  readonly taintedOrigins: string;
  readonly loginOrigins: string | null;
}

const decodeOrigins = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const rows = (sql: SqlClient.SqlClient) =>
  sql<Row>`
    SELECT profile_id AS "profileId", login_used AS "loginUsed",
      tainted_origins AS "taintedOrigins", login_origins AS "loginOrigins"
    FROM personal_browser_protection ORDER BY profile_id
  `;

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "090_PersonalBrowserLoginOrigins",
  (it) => {
    it.effect(
      "takes every saved-login and login-request origin for a profile that used a login",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 89 });
          yield* sql`INSERT INTO personal_logins
        (login_id, label, origin, username, secret_ref, sensitive, created_at, updated_at)
        VALUES
          ('one', 'One', 'https://bank.example', 'u', 'ref-1', 1, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
          ('two', 'Two', 'https://shop.example', 'u', 'ref-2', 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`;
          yield* sql`INSERT INTO personal_login_requests
        (request_id, task_id, thread_id, bot_id, origin, label, reason, tab_id, status, saved,
          created_at, expires_at)
        VALUES
          ('r1', 't', 'th', 'b', 'https://unsaved.example', 'Unsaved', 'why', 'tab', 'filled', 0,
            '2026-10-01T00:00:00Z', '2026-10-01T00:15:00Z'),
          ('r2', 't', 'th', 'b', 'https://bank.example', 'Bank', 'why', 'tab', 'filled', 1,
            '2026-10-01T00:00:00Z', '2026-10-01T00:15:00Z')`;
          yield* sql`INSERT INTO personal_browser_protection (profile_id, login_used, tainted_origins)
        VALUES ('default', 1, '["https://tainted.example"]'), ('unused', 0, '[]')`;

          yield* runMigrations({ toMigrationInclusive: 90 });

          const [used, unused] = yield* rows(sql);
          assert.strictEqual(used?.loginUsed, 1);
          assert.strictEqual(used?.taintedOrigins, '["https://tainted.example"]');
          assert.deepEqual(decodeOrigins(used?.loginOrigins).toSorted(), [
            "https://bank.example",
            "https://shop.example",
            "https://unsaved.example",
          ]);
          // Never used a login: nothing to scope, and nothing is blocked.
          assert.strictEqual(unused?.loginUsed, 0);
          assert.strictEqual(unused?.loginOrigins, null);
        }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "090_PersonalBrowserLoginOrigins without known origins",
  (it) => {
    it.effect("leaves the origins unknown, so page scripts stay disabled everywhere", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 89 });
        yield* sql`INSERT INTO personal_browser_protection (profile_id, login_used, tainted_origins)
          VALUES ('default', 1, '[]')`;
        yield* runMigrations({ toMigrationInclusive: 90 });
        const [row] = yield* rows(sql);
        assert.strictEqual(row?.loginUsed, 1);
        assert.strictEqual(row?.loginOrigins, null);
      }),
    );
  },
);
