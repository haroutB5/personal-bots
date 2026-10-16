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

      assert.deepEqual(
        (yield* repository.listNeedingSummary({ threadId: chat, limit: 10, maxAttempts: 3 })).map(
          (row) => row.callId,
        ),
        ["n-spoken"],
      );
      // Once a summary is written the call drops out of the list for good.
      assert.isTrue(yield* repository.setSummary({ callId: "n-spoken", summary: SUMMARY }));
      assert.deepEqual(
        yield* repository.listNeedingSummary({ threadId: chat, limit: 10, maxAttempts: 3 }),
        [],
      );
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
      assert.deepEqual(
        (yield* repository.listNeedingSummary({ threadId: chat, limit: 2, maxAttempts: 3 })).map(
          (row) => row.callId,
        ),
        ["cap-4", "cap-3"],
      );
      assert.equal(
        (yield* repository.listNeedingSummary({ threadId: chat, limit: 50, maxAttempts: 3 }))
          .length,
        5,
      );
      // A call that is out of attempts is not offered again, however new it is.
      yield* repository.recordSummaryAttempt("cap-4");
      yield* repository.recordSummaryAttempt("cap-4");
      yield* repository.recordSummaryAttempt("cap-4");
      assert.deepEqual(
        (yield* repository.listNeedingSummary({ threadId: chat, limit: 50, maxAttempts: 3 })).map(
          (row) => row.callId,
        ),
        ["cap-3", "cap-2", "cap-1", "cap-0"],
      );
    }),
  );

  // Astra re-check R3: a keyset cursor, not an offset, is what lets the sweep
  // walk past rows it will never be able to write.
  it.effect("pages older calls with the cursor, never skipping the row after a written one", () =>
    Effect.gen(function* () {
      const repository = yield* setup;
      const chat = ThreadId.make("thread-cursor");
      for (let index = 0; index < 4; index += 1) {
        yield* insert({
          callId: `cur-${String(index)}`,
          threadId: chat,
          transcript: spoken(`line ${String(index)}`),
          startedAt: `2026-10-15T1${String(index)}:00:00.000Z`,
          endedAt: `2026-10-15T1${String(index)}:04:12.000Z`,
        });
      }
      const first = yield* repository.listNeedingSummary({
        threadId: chat,
        limit: 2,
        maxAttempts: 3,
      });
      assert.deepEqual(
        first.map((row) => row.callId),
        ["cur-3", "cur-2"],
      );
      // The newest row is written and therefore leaves the result set; the
      // cursor still points just past it, so the page after it is cur-1 and
      // cur-0, exactly the rows an offset of 2 would have skipped.
      assert.isTrue(yield* repository.setSummary({ callId: "cur-3", summary: SUMMARY }));
      const last = first[first.length - 1]!;
      assert.deepEqual(
        (yield* repository.listNeedingSummary({
          threadId: chat,
          limit: 2,
          maxAttempts: 3,
          after: { startedAt: last.startedAt, rowId: last.rowId },
        })).map((row) => row.callId),
        ["cur-1", "cur-0"],
      );
    }),
  );

  // Astra review, finding 3: a reply that lands before the summary is written
  // must not retire a summary the bot never saw, so eligibility is "has this
  // summary been put into a turn's context", not a timestamp.
  it.effect("gives the bot a call summary until it has been delivered to a turn", () =>
    Effect.gen(function* () {
      const repository = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const chat = ThreadId.make("thread-turn");
      yield* insert({ callId: "t-1", threadId: chat, transcript: spoken("court three") });
      yield* repository.setSummary({ callId: "t-1", summary: SUMMARY });

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

      // A reply written BEFORE the summary existed changes nothing: the bot
      // never saw those lines.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'm-before', ${chat}, 'assistant', 'Earlier reply', 0,
          '2026-10-15T16:00:00.000Z', '2026-10-15T16:00:00.000Z'
        )
      `;
      assert.equal((yield* repository.summariesForTurn({ threadId: chat, limit: 2 })).length, 1);

      // Delivered: now it is retired, and stays retired.
      yield* repository.markSummariesDelivered({
        callIds: ["t-1"],
        at: DateTime.makeUnsafe("2026-10-15T17:10:00.000Z"),
      });
      assert.deepEqual(yield* repository.summariesForTurn({ threadId: chat, limit: 2 }), []);
      // A second marking is a no-op, and an unknown id is simply ignored.
      yield* repository.markSummariesDelivered({
        callIds: ["t-1", "no-such-call"],
        at: DateTime.makeUnsafe("2026-10-15T17:11:00.000Z"),
      });
      // An empty list is a no-op too (it must not build an `IN ()`).
      yield* repository.markSummariesDelivered({
        callIds: [],
        at: DateTime.makeUnsafe("2026-10-15T17:12:00.000Z"),
      });
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
