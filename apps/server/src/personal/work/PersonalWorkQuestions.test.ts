// @effect-diagnostics preferSchemaOverJson:off - seeds the projection payloads as stored JSON.
import { PersonalBotId, PersonalWorkQuestionsResult, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { PERSONAL_V2_RELATIONS } from "../engine/PersonalProjectionRelationsV2Live.ts";
import { PersonalProjectionRelations } from "../engine/PersonalProjectionRelations.ts";
import { MARKED_UNREAD_GRACE_MS } from "../PersonalBotRepository.ts";
import * as PersonalWorkReads from "./PersonalWorkReads.ts";

const layer = Layer.merge(
  SqlitePersistence.layerMemory,
  Layer.succeed(PersonalProjectionRelations, PERSONAL_V2_RELATIONS),
);

const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const AT = "2026-11-15T09:00:00.000Z";
const REPLY = "Delete 9 merged branches?\n\n```choices\nYes, delete\nKeep\n```";

const seedBot = (input: {
  readonly botId: string;
  readonly enabled?: number;
  readonly deletedAt?: string | null;
  readonly hidePreviews?: number;
}) => {
  const botId = PersonalBotId.make(input.botId);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, hide_previews, deleted_at,
        created_at, updated_at
      )
      VALUES (
        ${botId}, ${input.botId}, '', '', 'blob', '#1A73E8', '{}',
        ${input.enabled ?? 1}, 0, ${input.hidePreviews ?? 0}, ${input.deletedAt ?? null},
        ${AT}, ${AT}
      )
    `;
  });
};

const seedChat = (input: {
  readonly threadId: string;
  readonly botId: string;
  readonly title?: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}) => {
  const threadId = ThreadId.make(input.threadId);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_bot_threads (thread_id, bot_id, created_at, archived_at)
      VALUES (${threadId}, ${input.botId}, ${AT}, ${input.archivedAt ?? null})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at, payload_json
      )
      VALUES (
        ${threadId}, 'project', ${input.title ?? input.threadId}, 'claude', 'full-access',
        'default', ${AT}, ${AT}, ${input.archivedAt ?? null}, ${input.deletedAt ?? null}, '{}'
      )
    `;
  });
};

const seedMessage = (input: {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt?: string;
  /** When the row last changed; the row's `created_at` when omitted. */
  readonly updatedAt?: string;
  readonly streaming?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = input.createdAt ?? AT;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, role, streaming, created_at, updated_at, payload_json
      )
      VALUES (
        ${input.messageId}, ${input.threadId}, ${input.role}, ${input.streaming === true ? 1 : 0},
        ${createdAt}, ${input.updatedAt ?? createdAt},
        json_object('text', ${input.text})
      )
    `;
  });

/** One live bot chat whose newest message is `REPLY`. */
const seedQuestionChat = (threadId: string) =>
  Effect.gen(function* () {
    yield* seedBot({ botId: "bot-a" });
    yield* seedChat({ threadId, botId: "bot-a", title: "Branch cleanup" });
    yield* seedMessage({ messageId: `${threadId}-m1`, threadId, role: "assistant", text: REPLY });
  });

describe("PersonalWorkReads.questions", () => {
  it.effect("reads the question and its options from the reply's choices block", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedQuestionChat("thread-a");

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toEqual([
        {
          threadId: "thread-a",
          botId: "bot-a",
          messageId: "thread-a-m1",
          askedAt: expect.anything(),
          question: "Delete 9 merged branches?",
          options: ["Yes, delete", "Keep"],
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an owner message after the reply ends the question", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedQuestionChat("thread-a");
      yield* seedMessage({
        messageId: "thread-a-m2",
        threadId: "thread-a",
        role: "user",
        text: "Keep",
        createdAt: "2026-11-15T09:30:00.000Z",
      });
      yield* seedChat({ threadId: "thread-b", botId: "bot-a" });
      yield* seedMessage({
        messageId: "thread-b-m1",
        threadId: "thread-b",
        role: "assistant",
        text: REPLY,
      });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId)).toEqual(["thread-b"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a reply exactly 72 hours old or older no longer asks", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedBot({ botId: "bot-a" });
      yield* seedChat({ threadId: "older", botId: "bot-a" });
      yield* seedMessage({
        messageId: "older-m1",
        threadId: "older",
        role: "assistant",
        text: REPLY,
        createdAt: "2026-11-12T11:00:00.000Z",
      });
      yield* seedChat({ threadId: "inside", botId: "bot-a" });
      yield* seedMessage({
        messageId: "inside-m1",
        threadId: "inside",
        role: "assistant",
        text: REPLY,
        createdAt: "2026-11-12T12:00:01.000Z",
      });
      yield* seedChat({ threadId: "boundary", botId: "bot-a" });
      yield* seedMessage({
        messageId: "boundary-m1",
        threadId: "boundary",
        role: "assistant",
        text: REPLY,
        createdAt: "2026-11-12T12:00:00.000Z",
      });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId)).toEqual(["inside"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an archived chat, a relay chat and a task chat are left out", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedBot({ botId: "bot-a" });
      yield* seedChat({ threadId: "open", botId: "bot-a" });
      yield* seedMessage({
        messageId: "open-m1",
        threadId: "open",
        role: "assistant",
        text: REPLY,
      });
      yield* seedChat({ threadId: "archived", botId: "bot-a", archivedAt: AT });
      yield* seedMessage({
        messageId: "archived-m1",
        threadId: "archived",
        role: "assistant",
        text: REPLY,
      });
      yield* seedChat({ threadId: "relay", botId: "bot-a" });
      yield* seedMessage({
        messageId: "relay-m1",
        threadId: "relay",
        role: "assistant",
        text: REPLY,
      });
      yield* seedChat({ threadId: "task", botId: "bot-a" });
      yield* seedMessage({
        messageId: "task-m1",
        threadId: "task",
        role: "assistant",
        text: REPLY,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO personal_groups (
          group_id, name, description, thread_id, max_bot_turns, created_at, updated_at
        )
        VALUES ('group-1', 'Team', '', 'group-thread', 3, ${AT}, ${AT})
      `;
      yield* sql`
        INSERT INTO personal_group_members (group_id, bot_id, thread_id, joined_at)
        VALUES ('group-1', 'bot-a', 'relay', ${AT})
      `;
      yield* sql`
        INSERT INTO personal_tasks (
          task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective,
          acceptance_criteria, expected_output, status, source, idempotency_key, depth,
          max_depth, max_children, created_at, updated_at
        )
        VALUES (
          'task-1', 'task-1', NULL, 'bot-a', 'task', 'Do it', 'o', '', '', 'running',
          'delegation', 'key-1', 1, 3, 5, ${AT}, ${AT}
        )
      `;

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId)).toEqual(["open"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a hidden-previews bot sends the card without question text or options", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedBot({ botId: "bot-quiet", hidePreviews: 1 });
      yield* seedChat({ threadId: "quiet", botId: "bot-quiet" });
      yield* seedMessage({
        messageId: "quiet-m1",
        threadId: "quiet",
        role: "assistant",
        text: REPLY,
      });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toEqual([
        {
          threadId: "quiet",
          botId: "bot-quiet",
          messageId: "quiet-m1",
          askedAt: expect.anything(),
          question: null,
          options: null,
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the 10 newest questions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedBot({ botId: "bot-a" });
      for (let index = 0; index < 12; index += 1) {
        const threadId = `thread-${String(index).padStart(2, "0")}`;
        yield* seedChat({ threadId, botId: "bot-a" });
        yield* seedMessage({
          messageId: `${threadId}-m1`,
          threadId,
          role: "assistant",
          text: REPLY,
          createdAt: new Date(Date.UTC(2026, 10, 15, 9, index, 0)).toISOString(),
        });
      }

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toHaveLength(10);
      expect(result.questions[0]?.threadId).toBe("thread-11");
      expect(result.questions.at(-1)?.threadId).toBe("thread-02");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a bot that is not live has no question", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedBot({ botId: "bot-off", enabled: 0 });
      yield* seedChat({ threadId: "off", botId: "bot-off" });
      yield* seedMessage({ messageId: "off-m1", threadId: "off", role: "assistant", text: REPLY });
      yield* seedBot({ botId: "bot-a" });
      yield* seedChat({ threadId: "live", botId: "bot-a" });
      yield* seedMessage({
        messageId: "live-m1",
        threadId: "live",
        role: "assistant",
        text: REPLY,
      });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId)).toEqual(["live"]);
    }).pipe(Effect.provide(layer)),
  );
});

/** The owner's last view of a chat, and an optional "mark unread", as the server stamps them. */
const seedViewed = (input: {
  readonly threadId: string;
  readonly lastViewedAt: string | null;
  readonly markedUnreadAt?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE personal_bot_threads
      SET last_viewed_at = ${input.lastViewedAt}, marked_unread_at = ${input.markedUnreadAt ?? null}
      WHERE thread_id = ${input.threadId}
    `;
  });

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("questionAwaitsOwner", () => {
  const asked = at("2026-11-15T09:00:00.000Z");
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly lastViewedAt: string | null;
    readonly markedUnreadAt: string | null;
    readonly expected: boolean;
  }> = [
    { name: "never viewed", lastViewedAt: null, markedUnreadAt: null, expected: true },
    {
      name: "viewed before the question",
      lastViewedAt: "2026-11-15T08:59:59.999Z",
      markedUnreadAt: null,
      expected: true,
    },
    {
      name: "viewed at the moment of the question",
      lastViewedAt: "2026-11-15T09:00:00.000Z",
      markedUnreadAt: null,
      expected: false,
    },
    {
      name: "viewed after the question",
      lastViewedAt: "2026-11-15T09:05:00.000Z",
      markedUnreadAt: null,
      expected: false,
    },
    {
      name: "marked unread after the view",
      lastViewedAt: "2026-11-15T09:05:00.000Z",
      markedUnreadAt: "2026-11-15T09:05:10.000Z",
      expected: true,
    },
    {
      name: "marked unread, then left 10 s later (the leave stamps the view)",
      lastViewedAt: "2026-11-15T09:05:10.000Z",
      markedUnreadAt: "2026-11-15T09:05:00.000Z",
      expected: true,
    },
    {
      name: "marked unread 30 s before the view, so the grace ends at the view",
      lastViewedAt: "2026-11-15T09:05:30.000Z",
      markedUnreadAt: "2026-11-15T09:05:00.000Z",
      expected: false,
    },
    {
      name: "marked unread long before the view, then opened again",
      lastViewedAt: "2026-11-15T09:05:00.000Z",
      markedUnreadAt: "2026-11-15T09:01:00.000Z",
      expected: false,
    },
  ];
  for (const row of cases) {
    it(`${row.name}: ${row.expected ? "awaits" : "does not await"} the owner`, () => {
      expect(
        PersonalWorkReads.questionAwaitsOwner({
          askedAt: asked,
          lastViewedAt: row.lastViewedAt === null ? null : at(row.lastViewedAt),
          markedUnreadAt: row.markedUnreadAt === null ? null : at(row.markedUnreadAt),
        }),
      ).toBe(row.expected);
    });
  }

  it("uses the shared mark-unread grace", () => {
    expect(MARKED_UNREAD_GRACE_MS).toBe(30_000);
  });
});

describe("PersonalWorkReads.questions once the chat was viewed", () => {
  it.effect("keeps the card of a chat that was never opened", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedQuestionChat("thread-a");
      yield* seedViewed({ threadId: "thread-a", lastViewedAt: null });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId)).toEqual(["thread-a"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("hides the card when the view is at or after the reply", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedQuestionChat("equal");
      yield* seedViewed({ threadId: "equal", lastViewedAt: AT });
      yield* seedChat({ threadId: "later", botId: "bot-a" });
      yield* seedMessage({
        messageId: "later-m1",
        threadId: "later",
        role: "assistant",
        text: REPLY,
      });
      yield* seedViewed({ threadId: "later", lastViewedAt: "2026-11-15T09:10:00.000Z" });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("shows a newer question in a chat that was viewed before it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedQuestionChat("thread-a");
      yield* seedViewed({ threadId: "thread-a", lastViewedAt: "2026-11-15T08:00:00.000Z" });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId)).toEqual(["thread-a"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "brings the card back when the chat is marked unread, and keeps it hidden after a later open",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const viewed = Date.parse("2026-11-15T09:10:00.000Z");
        const iso = (offsetMs: number) => new Date(viewed + offsetMs).toISOString();
        // Marked unread 10 s before the leave stamped the view: the leave must not clear it.
        yield* seedQuestionChat("marked-then-left");
        yield* seedViewed({
          threadId: "marked-then-left",
          lastViewedAt: iso(0),
          markedUnreadAt: iso(-10_000),
        });
        // Marked unread after the view.
        yield* seedChat({ threadId: "marked-after", botId: "bot-a" });
        yield* seedMessage({
          messageId: "marked-after-m1",
          threadId: "marked-after",
          role: "assistant",
          text: REPLY,
        });
        yield* seedViewed({
          threadId: "marked-after",
          lastViewedAt: iso(0),
          markedUnreadAt: iso(MARKED_UNREAD_GRACE_MS + 1000),
        });
        // Marked unread, then opened again a minute later: seen.
        yield* seedChat({ threadId: "opened-again", botId: "bot-a" });
        yield* seedMessage({
          messageId: "opened-again-m1",
          threadId: "opened-again",
          role: "assistant",
          text: REPLY,
        });
        yield* seedViewed({
          threadId: "opened-again",
          lastViewedAt: iso(0),
          markedUnreadAt: iso(-MARKED_UNREAD_GRACE_MS - 1000),
        });

        const result = yield* PersonalWorkReads.questions();

        expect(result.questions.map((question) => question.threadId).toSorted()).toEqual([
          "marked-after",
          "marked-then-left",
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("hides the card of a hidden-previews bot once the chat was viewed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedBot({ botId: "bot-quiet", hidePreviews: 1 });
      yield* seedChat({ threadId: "quiet", botId: "bot-quiet" });
      yield* seedMessage({
        messageId: "quiet-m1",
        threadId: "quiet",
        role: "assistant",
        text: REPLY,
      });
      yield* seedViewed({ threadId: "quiet", lastViewedAt: "2026-11-15T09:30:00.000Z" });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not spend one of the 10 slots on a viewed question", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedBot({ botId: "bot-a" });
      for (let index = 0; index < 11; index += 1) {
        const threadId = `thread-${String(index).padStart(2, "0")}`;
        yield* seedChat({ threadId, botId: "bot-a" });
        yield* seedMessage({
          messageId: `${threadId}-m1`,
          threadId,
          role: "assistant",
          text: REPLY,
          createdAt: new Date(Date.UTC(2026, 10, 15, 9, index, 0)).toISOString(),
        });
      }
      yield* seedViewed({ threadId: "thread-10", lastViewedAt: "2026-11-15T11:00:00.000Z" });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toHaveLength(10);
      expect(result.questions.map((question) => question.threadId)).not.toContain("thread-10");
      expect(result.questions[0]?.threadId).toBe("thread-09");
      expect(result.questions.at(-1)?.threadId).toBe("thread-00");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an old phone gets the rule with the same six fields and no new field", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedQuestionChat("seen");
      yield* seedViewed({ threadId: "seen", lastViewedAt: "2026-11-15T09:10:00.000Z" });
      yield* seedChat({ threadId: "fresh", botId: "bot-a" });
      yield* seedMessage({
        messageId: "fresh-m1",
        threadId: "fresh",
        role: "assistant",
        text: REPLY,
      });

      const result = yield* PersonalWorkReads.questions();
      const wire = Schema.encodeSync(PersonalWorkQuestionsResult)(result);

      expect(wire.questions.map((question) => question.threadId)).toEqual(["fresh"]);
      expect(Object.keys(wire.questions[0] ?? {}).toSorted()).toEqual([
        "askedAt",
        "botId",
        "messageId",
        "options",
        "question",
        "threadId",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});

describe("PersonalWorkReads.questions for a reply that streamed while the owner was in the chat", () => {
  // The row is created when the final text starts (T) and settles when it finishes (T + 10 s).
  const T = Date.parse("2026-11-15T09:00:00.000Z");
  const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString();

  const seedStreamed = (input: {
    readonly threadId: string;
    readonly streaming?: boolean;
    readonly finishedAfterMs?: number;
    readonly lastViewedAfterMs: number | null;
    readonly markedUnreadAfterMs?: number | null;
  }) =>
    Effect.gen(function* () {
      yield* seedBot({ botId: "bot-a" });
      yield* seedChat({ threadId: input.threadId, botId: "bot-a" });
      yield* seedMessage({
        messageId: `${input.threadId}-m1`,
        threadId: input.threadId,
        role: "assistant",
        text: REPLY,
        createdAt: iso(0),
        updatedAt: iso(input.finishedAfterMs ?? 10_000),
        ...(input.streaming === undefined ? {} : { streaming: input.streaming }),
      });
      yield* seedViewed({
        threadId: input.threadId,
        lastViewedAt: input.lastViewedAfterMs === null ? null : iso(input.lastViewedAfterMs),
        markedUnreadAt: input.markedUnreadAfterMs == null ? null : iso(input.markedUnreadAfterMs),
      });
    });

  it.effect("shows the card when the owner left while the question was still streaming", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedStreamed({ threadId: "left-mid-stream", lastViewedAfterMs: 5_000 });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId)).toEqual(["left-mid-stream"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("hides the card when the owner left after the question finished", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedStreamed({ threadId: "left-after", lastViewedAfterMs: 12_000 });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "hides the card when view heartbeats ran during the stream and the leave came after the finish",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        // Heartbeats at T + 2 s and T + 8 s are overwritten by the leave at T + 11 s.
        yield* seedStreamed({ threadId: "heartbeat-then-leave", lastViewedAfterMs: 11_000 });

        const result = yield* PersonalWorkReads.questions();

        expect(result.questions).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("hides the card when the owner views exactly as the question finished", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedStreamed({ threadId: "view-at-finish", lastViewedAfterMs: 10_000 });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("still brings the card back when the chat is marked unread after the finish", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      // Seen at T + 12 s, then marked unread past the grace: back.
      yield* seedStreamed({
        threadId: "marked-after-view",
        lastViewedAfterMs: 12_000,
        markedUnreadAfterMs: 12_000 + MARKED_UNREAD_GRACE_MS + 1_000,
      });
      // Marked unread at T + 11 s, the leave stamped T + 12 s: the grace keeps it.
      yield* seedChat({ threadId: "marked-then-left", botId: "bot-a" });
      yield* seedMessage({
        messageId: "marked-then-left-m1",
        threadId: "marked-then-left",
        role: "assistant",
        text: REPLY,
        createdAt: iso(0),
        updatedAt: iso(10_000),
      });
      yield* seedViewed({
        threadId: "marked-then-left",
        lastViewedAt: iso(12_000),
        markedUnreadAt: iso(11_000),
      });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions.map((question) => question.threadId).toSorted()).toEqual([
        "marked-after-view",
        "marked-then-left",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives no card while the reply is still streaming", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedStreamed({
        threadId: "still-streaming",
        streaming: true,
        finishedAfterMs: 4_000,
        lastViewedAfterMs: null,
      });

      const result = yield* PersonalWorkReads.questions();

      expect(result.questions).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the card's age and order on the row's creation time, with six wire fields", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* seedStreamed({ threadId: "older-finished-later", lastViewedAfterMs: null });
      // A newer question that finished before the older one did.
      yield* seedChat({ threadId: "newer-finished-first", botId: "bot-a" });
      yield* seedMessage({
        messageId: "newer-finished-first-m1",
        threadId: "newer-finished-first",
        role: "assistant",
        text: REPLY,
        createdAt: iso(2_000),
        updatedAt: iso(3_000),
      });

      const result = yield* PersonalWorkReads.questions();
      const wire = Schema.encodeSync(PersonalWorkQuestionsResult)(result);

      expect(wire.questions.map((question) => question.threadId)).toEqual([
        "newer-finished-first",
        "older-finished-later",
      ]);
      expect(wire.questions.map((question) => question.askedAt)).toEqual([iso(2_000), iso(0)]);
      expect(Object.keys(wire.questions[0] ?? {}).toSorted()).toEqual([
        "askedAt",
        "botId",
        "messageId",
        "options",
        "question",
        "threadId",
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
