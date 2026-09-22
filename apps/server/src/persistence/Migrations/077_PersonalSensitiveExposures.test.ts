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

it.layer(NodeSqliteClient.layerMemory())("077_PersonalSensitiveExposures", (it) => {
  it.effect("adds the exposure table at 77, one row per key, kind and value", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'personal_sensitive_exposures'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 77 });
      const insert = (kind: string) => sql`
        INSERT INTO personal_sensitive_exposures (exposure_key, kind, value, created_at)
        VALUES ('thread:t1', ${kind}, 'https://bank.example', '2026-09-22T00:00:00.000Z')
      `;
      yield* insert("source");
      yield* insert("approved");
      yield* refuses("duplicate row", insert("source"));
      yield* refuses("unknown kind", insert("seen"));
      const rows = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM personal_sensitive_exposures ORDER BY kind
      `;
      assert.deepEqual(rows, [{ kind: "approved" }, { kind: "source" }]);
    }),
  );
});
