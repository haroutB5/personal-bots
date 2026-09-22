import { PersonalConnectionVendorId } from "@t3tools/contracts";
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

const approval = (
  sql: SqlClient.SqlClient,
  input: { readonly approvalId: string; readonly vendorId: string; readonly outcome?: string },
) => sql`
  INSERT INTO personal_connection_approvals (
    approval_id, connection_id, vendor_id, operation_id, action_digest, risk_reason,
    summary, target_resources_json, credential_version, thread_id, bot_id, status,
    created_at, expires_at, executed_at, execution_outcome
  ) VALUES (
    ${input.approvalId}, ${`connection-${input.vendorId}`}, ${input.vendorId},
    ${`${input.vendorId}.operation`}, ${`digest-${input.approvalId}`}, 'account_write',
    'Server-written summary.', '[]', 1, 'thread-1', 'bot-1', 'approved',
    '2026-09-22T00:00:00.000Z', '2026-09-22T00:15:00.000Z',
    ${input.outcome === undefined ? null : "2026-09-22T00:01:00.000Z"},
    ${input.outcome ?? null}
  )
`;

/**
 * One story, one test: `it.layer` shares one in-memory database across the
 * file, so the pre-migration state cannot be had twice.
 */
it.layer(NodeSqliteClient.layerMemory())("076_PersonalConnectionApprovalsWhatsApp", (it) => {
  it.effect("accepts an approval for every catalog vendor and keeps the rows it copied", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* approval(sql, { approvalId: "kept", vendorId: "github", outcome: "succeeded" });
      yield* refuses(
        "whatsapp before migration 76",
        approval(sql, { approvalId: "early", vendorId: "whatsapp" }),
      );

      yield* runMigrations({ toMigrationInclusive: 76 });

      const kept = yield* sql<{
        readonly approval_id: string;
        readonly vendor_id: string;
        readonly execution_outcome: string | null;
      }>`SELECT approval_id, vendor_id, execution_outcome FROM personal_connection_approvals`;
      assert.deepEqual(kept, [
        { approval_id: "kept", vendor_id: "github", execution_outcome: "succeeded" },
      ]);

      // Every vendor the contract decodes, not a hand-kept list: the next
      // vendor added to the catalog fails here until its approvals can be
      // stored, rather than in production on its first card.
      for (const vendorId of PersonalConnectionVendorId.literals) {
        yield* approval(sql, { approvalId: `approval-${vendorId}`, vendorId });
        yield* sql`
          INSERT INTO personal_connections (
            connection_id, vendor_id, status, verified_capabilities_json,
            credential_ref, credential_version, created_at, updated_at
          ) VALUES (
            ${`connection-${vendorId}`}, ${vendorId}, 'connecting', '[]',
            ${`ref-${vendorId}`}, 1, '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z'
          )
        `;
      }

      // The claim the gateway writes before it calls the vendor.
      yield* approval(sql, { approvalId: "claimed", vendorId: "vercel", outcome: "dispatching" });
      yield* refuses(
        "unknown outcome",
        approval(sql, { approvalId: "bogus-outcome", vendorId: "vercel", outcome: "maybe" }),
      );
      yield* refuses(
        "unknown vendor",
        approval(sql, { approvalId: "bogus-vendor", vendorId: "telegram" }),
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'personal_connection_approvals'
          AND name LIKE 'idx_%'
        ORDER BY name
      `;
      assert.deepEqual(indexes, [
        { name: "idx_personal_connection_approvals_digest" },
        { name: "idx_personal_connection_approvals_status" },
      ]);
    }),
  );
});
