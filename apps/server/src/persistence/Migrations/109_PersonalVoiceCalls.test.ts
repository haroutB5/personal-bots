import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("109_PersonalVoiceCalls", (it) => {
  it.effect("turns the switch on for the CTO alone and leaves every other bot off", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      const now = "2026-10-15T00:00:00.000Z";
      for (const [id, name] of [
        ["bot-cto", "CTO"],
        ["bot-qa", "QA"],
        ["bot-muse", "Muse"],
      ] as const) {
        yield* sql`
          INSERT INTO personal_bots (
            bot_id, name, description, instructions, avatar_shape, avatar_color,
            model_selection_json, enabled, sort_order, created_at, updated_at, deleted_at
          )
          VALUES (
            ${id}, ${name}, '', '', 'blob', '#1A73E8',
            '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', 1, 0,
            ${now}, ${now}, NULL
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 109 });
      // Running it again changes nothing: the migrator records what it applied.
      yield* runMigrations({ toMigrationInclusive: 109 });

      const rows = yield* sql<{ readonly botId: string; readonly allowed: number }>`
        SELECT bot_id AS "botId", allow_voice_calls AS "allowed"
        FROM personal_bots ORDER BY bot_id
      `;
      assert.deepEqual(rows, [
        { botId: "bot-cto", allowed: 1 },
        { botId: "bot-muse", allowed: 0 },
        { botId: "bot-qa", allowed: 0 },
      ]);
    }),
  );

  it.effect("stores one card per call id, with its transcript, and is safe to run twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 109 });

      const insert = (callId: string) => sql`
        INSERT INTO personal_voice_calls (
          call_id, thread_id, bot_id, started_at, ended_at, duration_seconds,
          end_reason, message_count, voice_name, model, detail, transcript_json, created_at
        )
        VALUES (
          ${callId}, 'thread-1', 'bot-cto', '2026-10-15T17:00:00.000Z',
          '2026-10-15T17:04:12.000Z', 252, 'hung_up', 1, 'Charon', 'gemini-3.8-live', '',
          '[{"speaker":"you","text":"check the gates","at":"2026-10-15T17:00:05.000Z"}]',
          '2026-10-15T17:04:13.000Z'
        )
        ON CONFLICT(call_id) DO NOTHING
      `;
      yield* insert("call-1");
      // The second write of the same call is a no-op, which is what makes
      // `finish` idempotent.
      yield* insert("call-1");

      const rows = yield* sql<{
        readonly callId: string;
        readonly transcript: string;
        readonly messages: number;
      }>`
        SELECT call_id AS "callId", transcript_json AS "transcript",
               message_count AS "messages"
        FROM personal_voice_calls
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.callId, "call-1");
      assert.equal(rows[0]!.messages, 1);
      assert.include(rows[0]!.transcript, "check the gates");

      // The card is not a chat message: nothing was written to the transcript
      // tables, so no bot can ever read it.
      const messages = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS "count" FROM projection_thread_messages
      `;
      assert.equal(Number(messages[0]!.count), 0);
    }),
  );
});
