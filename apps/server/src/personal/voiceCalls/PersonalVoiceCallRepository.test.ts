/**
 * The call-card table against the real SQLite: the cheap list (no transcript
 * read), the one-card transcript request, the delete that takes a chat's cards
 * with it when the chat is deleted (must-fix 9), and the open-call lease rows
 * the restart gates read from outside the server process.
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

const CHAT = ThreadId.make("thread-cto-chat");
const OTHER_CHAT = ThreadId.make("thread-other-chat");

const card = (callId: string, threadId: ThreadId): VoiceCallRecord => ({
  callId,
  threadId,
  botId: PersonalBotId.make("bot-cto"),
  startedAt: DateTime.makeUnsafe("2026-10-15T17:00:00.000Z"),
  endedAt: DateTime.makeUnsafe("2026-10-15T17:04:12.000Z"),
  durationSeconds: 252,
  endReason: "hung_up",
  messageCount: 1,
  voiceName: "Charon",
  model: "gemini-3.8-live",
  detail: "",
  transcript: [
    {
      speaker: "you",
      text: "check the gates",
      at: DateTime.makeUnsafe("2026-10-15T17:00:05.000Z"),
    },
  ],
});

const layer = PersonalVoiceCallRepository.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.layer(layer)("PersonalVoiceCallRepository", (it) => {
  const seed = Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 110 });
    const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
    const createdAt = DateTime.makeUnsafe("2026-10-15T17:04:13.000Z");
    yield* repository.insert({ record: card("call-1", CHAT), createdAt });
    yield* repository.insert({ record: card("call-kept", OTHER_CHAT), createdAt });
    return repository;
  });

  it.effect("lists a chat's cards without reading any transcript", () =>
    Effect.gen(function* () {
      const repository = yield* seed;
      const listed = yield* repository.listByThread(CHAT, 50);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.callId, "call-1");
      // The list is cheap on purpose: a chat with fifty calls reads no
      // transcript at all.
      assert.deepEqual(listed[0]!.transcript, []);
    }),
  );

  it.effect("serves one card's transcript on demand, and none for an unknown call", () =>
    Effect.gen(function* () {
      const repository = yield* seed;
      const found = yield* repository.getTranscript("call-1");
      assert.isTrue(Option.isSome(found));
      assert.deepEqual(
        found.pipe(Option.map((rows) => rows.map((row) => row.text))),
        Option.some(["check the gates"]),
      );
      const missing = yield* repository.getTranscript("call-nowhere");
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("deletes only the deleted chat's cards and reports how many went", () =>
    Effect.gen(function* () {
      const repository = yield* seed;
      const removed = yield* repository.deleteByThread(CHAT);
      assert.equal(removed, 1);
      assert.deepEqual(yield* repository.listByThread(CHAT, 50), []);
      // The other chat keeps its card: only the deleted one goes.
      const kept = yield* repository.listByThread(OTHER_CHAT, 50);
      assert.equal(kept.length, 1);
      assert.equal(kept[0]!.callId, "call-kept");
      // A second delete has nothing left to do and says so.
      assert.equal(yield* repository.deleteByThread(CHAT), 0);
    }),
  );

  it.effect("removes nothing for a chat that never had a call", () =>
    Effect.gen(function* () {
      const repository = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      assert.equal(yield* repository.deleteByThread(ThreadId.make("thread-none")), 0);
      const [count] = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS "count" FROM personal_voice_calls
      `;
      assert.equal(Number(count?.count), 2);
    }),
  );

  const lease = (callId: string, threadId: ThreadId, expiresAt: string) =>
    Effect.gen(function* () {
      const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
      yield* repository.openLease({
        callId,
        threadId,
        botId: PersonalBotId.make("bot-cto"),
        openedAt: DateTime.makeUnsafe("2026-10-15T17:00:00.000Z"),
        expiresAt: DateTime.makeUnsafe(expiresAt),
      });
    });

  const leaseRows = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly callId: string; readonly threadId: string }>`
      SELECT call_id AS "callId", thread_id AS "threadId"
      FROM personal_voice_call_leases ORDER BY call_id
    `;
  });

  it.effect("keeps one row per open call and removes it when the call is closed", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* lease("call-open", CHAT, "2026-10-15T17:35:00.000Z");
      // Writing the same call again refreshes the row instead of duplicating it.
      yield* lease("call-open", OTHER_CHAT, "2026-10-15T17:40:00.000Z");
      const rows = yield* leaseRows;
      assert.deepEqual(rows, [{ callId: "call-open", threadId: OTHER_CHAT }]);

      const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
      yield* repository.closeLease("call-open");
      assert.deepEqual(yield* leaseRows, []);
      // Closing a call that was never open is not an error: `finish` may retry.
      yield* repository.closeLease("call-open");
      assert.deepEqual(yield* leaseRows, []);
    }),
  );

  it.effect("prunes expired rows and clears every row at boot", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* lease("call-stale", CHAT, "2026-10-15T17:20:00.000Z");
      yield* lease("call-live", OTHER_CHAT, "2026-10-15T17:35:00.000Z");
      const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
      const pruned = yield* repository.pruneLeases(DateTime.makeUnsafe("2026-10-15T17:30:00.000Z"));
      assert.equal(pruned, 1);
      assert.deepEqual(yield* leaseRows, [{ callId: "call-live", threadId: OTHER_CHAT }]);
      // A restart ends every call, so boot clears what is left.
      assert.equal(yield* repository.clearLeases(), 1);
      assert.deepEqual(yield* leaseRows, []);
      assert.equal(yield* repository.clearLeases(), 0);
    }),
  );

  it.effect("a deleted chat's lease goes with the chat's cards", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* lease("call-here", CHAT, "2026-10-15T17:35:00.000Z");
      yield* lease("call-elsewhere", OTHER_CHAT, "2026-10-15T17:35:00.000Z");
      const repository = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;
      assert.equal(yield* repository.deleteLeasesByThread(CHAT), 1);
      assert.deepEqual(yield* leaseRows, [{ callId: "call-elsewhere", threadId: OTHER_CHAT }]);
      assert.equal(yield* repository.deleteLeasesByThread(CHAT), 0);
    }),
  );
});
