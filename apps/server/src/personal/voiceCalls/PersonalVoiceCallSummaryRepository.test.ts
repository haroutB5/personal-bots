/**
 * The two queries behind the call summary, against the real SQLite: the calls
 * that still need one, and the block a bot's next turn is given.
 *
 * Their own file, and each test seeds its own chat, so nothing here depends on
 * the order the card-table tests run in or on what they left behind.
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersonalBotId, ThreadId, type VoiceCallRecord } from "@t3tools/contracts";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as PersonalVoiceCallRepository from "./PersonalVoiceCallRepository.ts";

const SUMMARY = {
  summary: "He asked whether a court was free before his Saturday booking.",
  points: ["Court 3 free 11:00-12:00 Saturday"],
  decision: "No change, just wanted to know",
  open: null,
} as const;

const spoken = (text: string, at = "2026-10-15T17:00:05.000Z"): VoiceCallRecord["transcript"] => [
  { speaker: "you", text, at: DateTime.makeUnsafe(at) },
];

const layer = PersonalVoiceCallRepository.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.layer(layer)("PersonalVoiceCallRepository summaries", (it) => {
  const insert = (record: {
    readonly callId: string;
    readonly threadId: ThreadId;
    readonly transcript: VoiceCallRecord["transcript"];
    readonly startedAt?: string;
    readonly endedAt?: string;
  }) =>
    Effect.gen(function* () {
      const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
      yield* repository.insert({
        record: {
          callId: record.callId,
          threadId: record.threadId,
          botId: PersonalBotId.make("bot-cto"),
          startedAt: DateTime.makeUnsafe(record.startedAt ?? "2026-10-15T17:00:00.000Z"),
          endedAt: DateTime.makeUnsafe(record.endedAt ?? "2026-10-15T17:04:12.000Z"),
          durationSeconds: 252,
          endReason: "hung_up",
          messageCount: 1,
          voiceName: "Charon",
          model: "gemini-3.8-live",
          detail: "",
          transcript: record.transcript,
        },
        createdAt: DateTime.makeUnsafe("2026-10-15T17:04:13.000Z"),
      });
    });

  const setup = Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 111 });
    return yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
  });

  it.effect("offers only a call that has a transcript and no summary yet", () =>
    Effect.gen(function* () {
      const repository = yield* setup;
      const chat = ThreadId.make("thread-needing");
      yield* insert({ callId: "n-spoken", threadId: chat, transcript: spoken("check the gates") });
      // A call that failed before anyone spoke: nothing to summarise.
      yield* insert({ callId: "n-silent", threadId: chat, transcript: [] });

      assert.deepEqual(yield* repository.listNeedingSummary({ threadId: chat, limit: 10 }), [
        "n-spoken",
      ]);
      // Once a summary is written the call drops out of the list for good.
      assert.isTrue(yield* repository.setSummary({ callId: "n-spoken", summary: SUMMARY }));
      assert.deepEqual(yield* repository.listNeedingSummary({ threadId: chat, limit: 10 }), []);
    }),
  );

  it.effect("caps how many calls one sweep may be handed, newest first", () =>
    Effect.gen(function* () {
      const repository = yield* setup;
      const chat = ThreadId.make("thread-cap");
      for (let index = 0; index < 5; index += 1) {
        yield* insert({
          callId: `cap-${String(index)}`,
          threadId: chat,
          transcript: spoken(`line ${String(index)}`),
          startedAt: `2026-10-15T1${String(index)}:00:00.000Z`,
          endedAt: `2026-10-15T1${String(index)}:04:12.000Z`,
        });
      }
      assert.deepEqual(yield* repository.listNeedingSummary({ threadId: chat, limit: 2 }), [
        "cap-4",
        "cap-3",
      ]);
      assert.equal((yield* repository.listNeedingSummary({ threadId: chat, limit: 50 })).length, 5);
    }),
  );

  it.effect("gives the bot a call summary until the bot has answered it", () =>
    Effect.gen(function* () {
      const repository = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const chat = ThreadId.make("thread-turn");
      yield* insert({ callId: "t-1", threadId: chat, transcript: spoken("court three") });
      yield* repository.setSummary({ callId: "t-1", summary: SUMMARY });

      // The bot has not replied since the call: the summary is carried.
      const before = yield* repository.summariesForTurn({ threadId: chat, limit: 2 });
      assert.deepEqual(
        before.map((row) => row.callId),
        ["t-1"],
      );
      assert.deepEqual(before[0]!.summary, SUMMARY);
      // A call with no summary is not a call the bot can be told about.
      const bare = ThreadId.make("thread-turn-bare");
      yield* insert({ callId: "t-bare", threadId: bare, transcript: spoken("hello") });
      assert.deepEqual(yield* repository.summariesForTurn({ threadId: bare, limit: 2 }), []);

      // An earlier assistant reply does not retire it: only one written after
      // the call ended does.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'm-before', ${chat}, 'assistant', 'Earlier reply', 0,
          '2026-10-15T16:00:00.000Z', '2026-10-15T16:00:00.000Z'
        )
      `;
      assert.equal((yield* repository.summariesForTurn({ threadId: chat, limit: 2 })).length, 1);

      // A reply still streaming is not a reply yet.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'm-streaming', ${chat}, 'assistant', 'Court three', 1,
          '2026-10-15T17:05:00.000Z', '2026-10-15T17:05:00.000Z'
        )
      `;
      assert.equal((yield* repository.summariesForTurn({ threadId: chat, limit: 2 })).length, 1);

      // The bot's own finished reply after the call retires it for good.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'm-after', ${chat}, 'assistant', 'Court three it is', 0,
          '2026-10-15T17:06:00.000Z', '2026-10-15T17:06:00.000Z'
        )
      `;
      assert.deepEqual(yield* repository.summariesForTurn({ threadId: chat, limit: 2 }), []);
    }),
  );

  it.effect("never lets a hand-edited summary break a card", () =>
    Effect.gen(function* () {
      const repository = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const chat = ThreadId.make("thread-broken");
      yield* insert({ callId: "b-1", threadId: chat, transcript: spoken("court three") });
      yield* sql`
        UPDATE personal_voice_calls SET summary_json = '{"nonsense":true}'
        WHERE call_id = 'b-1'
      `;
      const stored = yield* repository.get("b-1");
      assert.isTrue(Option.isSome(stored));
      assert.isUndefined(Option.getOrNull(stored)?.summary);
      // The card still lists, and its transcript is still reachable.
      const listed = yield* repository.listByThread(chat, 50);
      assert.equal(listed.length, 1);
      assert.equal((yield* repository.getTranscript("b-1")).pipe(Option.isSome), true);
    }),
  );
});
