import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("104_PersonalMemoryEvidence", (it) => {
  it.effect("preserves legacy rows, adds nullable evidence, and runs twice safely", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      yield* sql`INSERT INTO personal_memory (memory_id, scope, kind, content, source, sensitivity, created_at, updated_at, version)
        VALUES ('legacy', 'shared', 'note', 'Legacy fact.', 'user', 'normal', '2026-01-01', '2026-01-01', 1)`;
      const before = yield* sql`SELECT * FROM personal_memory`;
      yield* runMigrations({ toMigrationInclusive: 104 });
      yield* runMigrations({ toMigrationInclusive: 104 });
      const after =
        yield* sql`SELECT m.*, temporal_kind, observed_at, verified_at, evidence_json, origin_thread_id, origin_message_id, conflict FROM personal_memory m`;
      expect(after[0]).toEqual({
        ...before[0],
        temporal_kind: null,
        observed_at: null,
        verified_at: null,
        evidence_json: null,
        origin_thread_id: null,
        origin_message_id: null,
        conflict: null,
      });
    }),
  );
});
