import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "090_PersonalBrowserLoginOrigins",
  (it) => {
    // Saved logins and login requests are not a complete history: a deleted
    // login's session can still be in the profile. So no origin is guessed.
    it.effect("leaves a legacy profile's login origins unknown even with saved logins", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 89 });
        yield* sql`INSERT INTO personal_logins
        (login_id, label, origin, username, secret_ref, sensitive, created_at, updated_at)
        VALUES ('one', 'One', 'https://bank.example', 'u', 'ref-1', 1,
          '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`;
        yield* sql`INSERT INTO personal_login_requests
        (request_id, task_id, thread_id, bot_id, origin, label, reason, tab_id, status, saved,
          created_at, expires_at)
        VALUES ('r1', 't', 'th', 'b', 'https://unsaved.example', 'Unsaved', 'why', 'tab',
          'filled', 0, '2026-10-01T00:00:00Z', '2026-10-01T00:15:00Z')`;
        yield* sql`INSERT INTO personal_browser_protection (profile_id, login_used, tainted_origins)
        VALUES ('default', 1, '["https://tainted.example"]'), ('unused', 0, '[]')`;
        const logins = yield* sql`SELECT * FROM personal_logins`;

        yield* runMigrations({ toMigrationInclusive: 90 });

        const rows = yield* sql<{
          readonly profileId: string;
          readonly loginUsed: number;
          readonly taintedOrigins: string;
          readonly loginOrigins: string | null;
        }>`
        SELECT profile_id AS "profileId", login_used AS "loginUsed",
          tainted_origins AS "taintedOrigins", login_origins AS "loginOrigins"
        FROM personal_browser_protection ORDER BY profile_id
      `;
        assert.deepEqual(rows, [
          {
            profileId: "default",
            loginUsed: 1,
            taintedOrigins: '["https://tainted.example"]',
            loginOrigins: null,
          },
          { profileId: "unused", loginUsed: 0, taintedOrigins: "[]", loginOrigins: null },
        ]);
        assert.deepEqual(yield* sql`SELECT * FROM personal_logins`, logins);
      }),
    );
  },
);
