import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("111_PersonalVoiceCallSummary", (it) => {
  it.effect("adds one additive summary column and leaves existing cards readable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 110 });

      const before = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_table_info('personal_voice_calls') ORDER BY cid
        `;
      assert.notInclude(
        before.map((column) => column.name),
        "summary_json",
      );

      // A card written by the previous release, before the column existed.
      yield* sql`
          INSERT INTO personal_voice_calls (
            call_id, thread_id, bot_id, started_at, ended_at, duration_seconds,
            end_reason, message_count, voice_name, model, detail, transcript_json, created_at
          )
          VALUES (
            'call-old', 'thread-1', 'bot-cto', '2026-10-16T13:59:17.443Z',
            '2026-10-16T14:02:05.126Z', 168, 'said_bye', 3, 'Charon', 'gemini-3.8-live', '',
            '[{"speaker":"you","text":"is court three free","at":"2026-10-16T14:01:04.183Z"}]',
            '2026-10-16T14:02:06.000Z'
          )
        `;

      yield* runMigrations({ toMigrationInclusive: 111 });
      // Additive and idempotent: a second run changes nothing, and the
      // migration only ever adds a column (no table is dropped or rebuilt),
      // which is what keeps a rollback binary-only.
      yield* runMigrations({ toMigrationInclusive: 111 });

      const after = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt: string | null;
      }>`
          SELECT name, type, "notnull" AS notnull, dflt_value AS dflt
          FROM pragma_table_info('personal_voice_calls')
          WHERE name = 'summary_json'
        `;
      assert.equal(after.length, 1);
      assert.equal(after[0]!.type, "TEXT");
      assert.equal(after[0]!.notnull, 1);
      assert.equal(after[0]!.dflt, "''");

      const rows = yield* sql<{ readonly callId: string; readonly summary: string }>`
          SELECT call_id AS "callId", summary_json AS "summary"
          FROM personal_voice_calls
        `;
      assert.deepEqual(rows, [{ callId: "call-old", summary: "" }]);

      // The transcript and the rest of the card survive the ALTER.
      const transcript = yield* sql<{ readonly transcript: string }>`
          SELECT transcript_json AS "transcript" FROM personal_voice_calls
        `;
      assert.include(transcript[0]!.transcript, "is court three free");
    }),
  );

  it.effect("a card with no summary is still a valid row and can gain one later", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 111 });
      yield* sql`
          INSERT INTO personal_voice_calls (
            call_id, thread_id, bot_id, started_at, ended_at, duration_seconds,
            end_reason, message_count, voice_name, model, detail, transcript_json, created_at
          )
          VALUES (
            'call-1', 'thread-1', 'bot-cto', '2026-10-16T13:59:17.443Z',
            '2026-10-16T14:02:05.126Z', 168, 'said_bye', 3, 'Charon', 'gemini-3.8-live', '',
            '[]', '2026-10-16T14:02:06.000Z'
          )
        `;
      yield* sql`
          UPDATE personal_voice_calls SET summary_json = '{"summary":"x","points":[],"decision":null,"open":null}'
          WHERE call_id = 'call-1'
        `;
      const rows = yield* sql<{ readonly summary: string }>`
          SELECT summary_json AS "summary" FROM personal_voice_calls
        `;
      assert.include(rows[0]!.summary, '"summary":"x"');
    }),
  );
});
