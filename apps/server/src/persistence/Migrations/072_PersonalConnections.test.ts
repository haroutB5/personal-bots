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

it.layer(NodeSqliteClient.layerMemory())("072_PersonalConnections", (it) => {
  it.effect("creates the connection table only at migration 72", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_connections'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 72 });
      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'personal_connections'
      `;
      assert.deepEqual(after, [{ name: "personal_connections" }]);
    }),
  );

  it.effect("enforces one account per vendor and valid status and version values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });

      yield* sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, verified_capabilities_json,
          credential_ref, credential_version, created_at, updated_at
        ) VALUES (
          'connection-1', 'github', 'connecting', '[]',
          'opaque-1', 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
        )
      `;

      yield* refuses(sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, verified_capabilities_json,
          credential_ref, credential_version, created_at, updated_at
        ) VALUES (
          'connection-2', 'github', 'connected', '[]',
          'opaque-2', 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
        )
      `);
      yield* refuses(sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, verified_capabilities_json,
          credential_ref, credential_version, created_at, updated_at
        ) VALUES (
          'connection-3', 'unknown', 'connected', '[]',
          'opaque-3', 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
        )
      `);
      yield* refuses(sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, verified_capabilities_json,
          credential_ref, credential_version, created_at, updated_at
        ) VALUES (
          'connection-4', 'vercel', 'invalid', '[]',
          'opaque-4', 1, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
        )
      `);
      yield* refuses(sql`
        INSERT INTO personal_connections (
          connection_id, vendor_id, status, verified_capabilities_json,
          credential_ref, credential_version, created_at, updated_at
        ) VALUES (
          'connection-5', 'vercel', 'connected', '[]',
          'opaque-5', 0, '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'
        )
      `);
    }),
  );
});
