import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("112_ProviderSessionHistory", (it) => {
  it.effect("adds one additive table that a previous binary ignores", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 111 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_session_history'
      `;
      assert.deepStrictEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 112 });
      // Additive and idempotent: a second run changes nothing, and the only
      // change is a new table, which is what keeps a rollback binary-only.
      yield* runMigrations({ toMigrationInclusive: 112 });

      yield* sql`
        INSERT INTO provider_session_history (thread_id, provider_name, session_id, first_seen_at)
        VALUES ('thread-1', 'claudeAgent', 'session-a', '2026-10-21T10:00:00.000Z')
      `;
      // The key is the triple, so the same session is recorded once; the
      // duplicate inserts nothing at all.
      const duplicate = yield* sql<{ readonly changes: number }>`
        INSERT OR IGNORE INTO provider_session_history (thread_id, provider_name, session_id, first_seen_at)
        VALUES ('thread-1', 'claudeAgent', 'session-a', '2026-10-21T11:00:00.000Z')
        RETURNING changes() AS "changes"
      `;
      assert.deepStrictEqual(duplicate, []);

      const rows = yield* sql<{
        readonly sessionId: string;
        readonly firstSeenAt: string;
      }>`
        SELECT session_id AS "sessionId", first_seen_at AS "firstSeenAt"
        FROM provider_session_history
      `;
      assert.deepStrictEqual(rows, [
        { sessionId: "session-a", firstSeenAt: "2026-10-21T10:00:00.000Z" },
      ]);
    }),
  );
});
