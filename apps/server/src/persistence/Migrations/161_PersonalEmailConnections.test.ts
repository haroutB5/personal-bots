import { PersonalConnectionVendorId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const refuses = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.equal(result._tag, "Failure", label);
  });

const connection = (
  sql: SqlClient.SqlClient,
  input: {
    readonly connectionId: string;
    readonly vendorId: string;
    readonly accountId?: string | null;
  },
) => sql`
  INSERT INTO personal_connections (
    connection_id, vendor_id, status, account_id, account_name, verified_capabilities_json,
    credential_ref, credential_version, created_at, updated_at
  ) VALUES (
    ${input.connectionId}, ${input.vendorId}, 'connected', ${input.accountId ?? null},
    ${input.accountId ?? null}, '[]', ${`ref-${input.connectionId}`}, 1,
    '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z'
  )
`;

const approval = (sql: SqlClient.SqlClient, input: { approvalId: string; vendorId: string }) => sql`
  INSERT INTO personal_connection_approvals (
    approval_id, connection_id, vendor_id, operation_id, action_digest, risk_reason,
    summary, target_resources_json, credential_version, thread_id, bot_id, status,
    created_at, expires_at
  ) VALUES (
    ${input.approvalId}, ${`connection-${input.vendorId}`}, ${input.vendorId},
    ${`${input.vendorId}.send`}, ${`digest-${input.approvalId}`}, 'publication',
    'Server-written summary.', '[]', 1, 'thread-1', 'bot-1', 'pending',
    '2026-11-19T00:00:00.000Z', '2026-11-19T00:15:00.000Z'
  )
`;

/**
 * One story, one test: `it.layer` shares one in-memory database across the
 * file, so the pre-migration state cannot be had twice.
 */
it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("161_PersonalEmailConnections", (it) => {
  it.effect(
    "opens the mailbox vendors to several accounts and keeps one row per other vendor",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 160 });
        yield* connection(sql, { connectionId: "kept-github", vendorId: "github" });
        yield* sql`
        UPDATE personal_connections
        SET account_name = 'haroutB5', settings_json = '{"whatsappDailySendCap":null}',
            credential_version = 3
        WHERE connection_id = 'kept-github'
      `;
        yield* refuses(
          "gmail before migration 161",
          connection(sql, { connectionId: "early", vendorId: "gmail", accountId: "a@gmail.com" }),
        );
        yield* refuses(
          "an approval for gmail before 161",
          approval(sql, { approvalId: "early", vendorId: "gmail" }),
        );

        yield* runMigrations({ toMigrationInclusive: 161 });

        const kept = yield* sql<{
          readonly connection_id: string;
          readonly account_name: string;
          readonly credential_version: number;
          readonly settings_json: string;
        }>`SELECT connection_id, account_name, credential_version, settings_json FROM personal_connections`;
        assert.deepEqual(kept, [
          {
            connection_id: "kept-github",
            account_name: "haroutB5",
            credential_version: 3,
            settings_json: '{"whatsappDailySendCap":null}',
          },
        ]);

        yield* connection(sql, {
          connectionId: "g1",
          vendorId: "gmail",
          accountId: "one@gmail.com",
        });
        yield* connection(sql, {
          connectionId: "g2",
          vendorId: "gmail",
          accountId: "two@gmail.com",
        });
        yield* connection(sql, {
          connectionId: "o1",
          vendorId: "outlook",
          accountId: "me@live.com",
        });
        yield* connection(sql, {
          connectionId: "o2",
          vendorId: "outlook",
          accountId: "me@outlook.com",
        });
        yield* refuses(
          "the same mailbox twice",
          connection(sql, { connectionId: "g3", vendorId: "gmail", accountId: "one@gmail.com" }),
        );
        // The same address at two different providers is two different mailboxes.
        yield* connection(sql, {
          connectionId: "o3",
          vendorId: "outlook",
          accountId: "one@gmail.com",
        });

        yield* refuses(
          "a second github connection",
          connection(sql, { connectionId: "second-github", vendorId: "github" }),
        );
        yield* connection(sql, { connectionId: "wa", vendorId: "whatsapp" });
        yield* refuses(
          "a second whatsapp connection",
          connection(sql, { connectionId: "wa2", vendorId: "whatsapp" }),
        );
        yield* refuses(
          "an unknown vendor",
          connection(sql, { connectionId: "bogus", vendorId: "telegram" }),
        );

        for (const vendorId of PersonalConnectionVendorId.literals) {
          yield* approval(sql, { approvalId: `approval-${vendorId}`, vendorId });
        }
        yield* refuses(
          "an approval for an unknown vendor",
          approval(sql, { approvalId: "bogus", vendorId: "telegram" }),
        );

        const indexes = yield* sql<{ readonly name: string; readonly tbl_name: string }>`
        SELECT name, tbl_name FROM sqlite_master
        WHERE type = 'index' AND name LIKE '%personal_connection%' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `;
        assert.deepEqual(
          indexes.map((index) => index.name),
          [
            "idx_personal_connection_approvals_digest",
            "idx_personal_connection_approvals_status",
            "idx_personal_connections_status",
            "ux_personal_connections_mailbox",
            "ux_personal_connections_single",
          ],
        );
      }),
  );
});
