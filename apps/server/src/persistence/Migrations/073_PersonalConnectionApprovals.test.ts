import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const refuses = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.equal(result._tag, "Failure");
  });

const insert = (values: string) => `INSERT INTO personal_connection_approvals (
  approval_id, connection_id, vendor_id, operation_id, action_digest, risk_reason,
  summary, target_resources_json, credential_version, thread_id, bot_id, status,
  created_at, expires_at
) VALUES (${values})`;

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "073_PersonalConnectionApprovals",
  (it) => {
    it.effect("creates the approval table only at migration 73", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 72 });
        const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'personal_connection_approvals'
      `;
        assert.deepEqual(before, []);

        yield* runMigrations({ toMigrationInclusive: 73 });
        const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'personal_connection_approvals'
      `;
        assert.deepEqual(after, [{ name: "personal_connection_approvals" }]);
      }),
    );

    it.effect("refuses a status, risk or outcome the gateway does not understand", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 73 });

        yield* sql.unsafe(
          insert(
            `'approval-1', 'connection-1', 'github', 'github.create_repository', 'digest-1',
           'account_write', 'Create the private GitHub repository x.', '[]', 1,
           'thread-1', 'bot-1', 'pending',
           '2026-09-20T00:00:00.000Z', '2026-09-20T00:15:00.000Z'`,
          ),
        );

        // A row the reader cannot classify would be an approval of unknown
        // strength, so the shape is enforced where it is written.
        yield* refuses(
          sql.unsafe(
            insert(
              `'approval-2', 'connection-1', 'github', 'github.create_repository', 'digest-1',
             'account_write', 'x', '[]', 1, 'thread-1', 'bot-1', 'half_approved',
             '2026-09-20T00:00:00.000Z', '2026-09-20T00:15:00.000Z'`,
            ),
          ),
        );
        yield* refuses(
          sql.unsafe(
            insert(
              `'approval-3', 'connection-1', 'github', 'github.create_repository', 'digest-1',
             'probably_fine', 'x', '[]', 1, 'thread-1', 'bot-1', 'pending',
             '2026-09-20T00:00:00.000Z', '2026-09-20T00:15:00.000Z'`,
            ),
          ),
        );
        yield* refuses(
          sql`
          UPDATE personal_connection_approvals
          SET execution_outcome = 'partly' WHERE approval_id = 'approval-1'
        `,
        );
      }),
    );
  },
);
