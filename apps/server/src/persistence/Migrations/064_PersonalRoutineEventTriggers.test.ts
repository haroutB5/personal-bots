import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("064_PersonalRoutineEventTriggers", (it) => {
  it.effect("adopts an existing routine as a scheduled one, untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* sql`
        INSERT INTO personal_routines (
          routine_id, bot_id, title, prompt, schedule_json, time_zone, enabled,
          missed_policy, next_due_utc, last_occurrence_local, created_at, updated_at
        ) VALUES (
          'before-upgrade', 'bot-1', 'Morning', 'Brief me.', '{"kind":"daily","time":"09:00"}',
          'Europe/London', 1, 'coalesce', '2026-09-15T08:00:00.000Z', NULL,
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 64 });

      const rows = yield* sql<{
        readonly trigger_kind: string;
        readonly schedule_json: string;
        readonly hook_token: string | null;
        readonly event_label: string | null;
        readonly last_fired_utc: string | null;
        readonly next_due_utc: string | null;
      }>`SELECT * FROM personal_routines WHERE routine_id = 'before-upgrade'`;
      assert.deepEqual(rows, [
        {
          ...rows[0],
          // Pre-existing rows are scheduled routines, with no hook and no backfill.
          trigger_kind: "schedule",
          schedule_json: '{"kind":"daily","time":"09:00"}',
          hook_token: null,
          event_label: null,
          last_fired_utc: null,
          next_due_utc: "2026-09-15T08:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect(
    "lets every scheduled routine share a null token but never two event routines one",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 64 });
        const insert = (routineId: string, token: string | null, trigger: string) => sql`
        INSERT INTO personal_routines (
          routine_id, bot_id, title, prompt, trigger_kind, schedule_json, hook_token,
          time_zone, enabled, missed_policy, next_due_utc, last_occurrence_local,
          created_at, updated_at
        ) VALUES (
          ${routineId}, 'bot-1', 'T', 'P', ${trigger}, 'null', ${token},
          'Europe/London', 1, 'coalesce', NULL, NULL,
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z'
        )
      `;
        yield* insert("a", null, "schedule");
        yield* insert("b", null, "schedule");
        yield* insert("c", "shared-token", "event");
        const clash = yield* insert("d", "shared-token", "event").pipe(Effect.result);
        assert.strictEqual(clash._tag, "Failure");
      }),
  );
});
