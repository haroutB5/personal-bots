import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const refuses = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.equal(result._tag, "Failure", label);
  });

/**
 * One story, one test: `it.layer` hands every test in the file the same
 * in-memory database, so a second test cannot get the pre-migration state
 * back.
 */
it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("075_PersonalWhatsApp", (it) => {
  it.effect("widens the vendor list and rebuilds the table without losing a connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const whatsapp = (connectionId: string) => sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, verified_capabilities_json,
          credential_ref, credential_version, created_at, updated_at
        ) VALUES (
          ${connectionId}, 'whatsapp', 'connecting', '[]',
          ${`ref-${connectionId}`}, 1, '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, account_name, verified_capabilities_json,
          credential_ref, credential_version, created_at, updated_at
        ) VALUES (
          'connection-1', 'github', 'connected', 'haroutB5', '["github.list_repositories"]',
          'opaque-1', 2, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
        )
      `;
      yield* refuses("whatsapp before migration 75", whatsapp("before"));

      yield* runMigrations({ toMigrationInclusive: 75 });

      // The rebuild is a copy, so the proof it worked is the row that was
      // already there arriving intact, settings and all.
      const rows = yield* sql<{
        readonly connection_id: string;
        readonly account_name: string;
        readonly credential_version: number;
        readonly settings_json: string;
      }>`SELECT connection_id, account_name, credential_version, settings_json FROM personal_connections`;
      assert.deepEqual(rows, [
        {
          connection_id: "connection-1",
          account_name: "haroutB5",
          credential_version: 2,
          settings_json: "{}",
        },
      ]);

      yield* whatsapp("after");
      // Widened, not dropped: an unknown vendor is still one nobody wrote an
      // adapter for, and one account per vendor survived the rebuild.
      yield* refuses(
        "unknown vendor",
        sql`
          INSERT INTO personal_connections (
            connection_id, vendor_id, status, verified_capabilities_json,
            credential_ref, credential_version, created_at, updated_at
          ) VALUES (
            'bogus', 'telegram', 'connecting', '[]', 'ref-bogus', 1,
            '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z'
          )
        `,
      );
      yield* refuses("second whatsapp account", whatsapp("second"));
    }),
  );

  it.effect("keeps the send ledger, because a cap held in memory resets on restart", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* sql`
        INSERT INTO personal_whatsapp_sends (send_id, connection_id, recipient_number, sent_at)
        VALUES ('send-1', 'connection-1', '+447700900001', '2026-09-21T10:00:00.000Z')
      `;
      const rows = yield* sql<{
        readonly send_id: string;
      }>`SELECT send_id FROM personal_whatsapp_sends WHERE connection_id = 'connection-1'`;
      assert.deepEqual(rows, [{ send_id: "send-1" }]);
    }),
  );
});
