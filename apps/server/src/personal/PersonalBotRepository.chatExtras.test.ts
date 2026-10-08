import { PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import {
  asciiLower,
  groupMessageSearchRows,
  PERSONAL_MESSAGE_SEARCH_RAW_ROWS,
  snippetOf,
} from "./personalMessageSearch.ts";

const testLayer = PersonalBotRepository.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const decodeCreateBot = Schema.decodeSync(PersonalBotRepository.CreatePersonalBotInput);
const decodeInsertThreadLink = Schema.decodeSync(
  PersonalBotRepository.InsertPersonalBotThreadInput,
);

const BOT = PersonalBotId.make("bot-extras");
const T0 = "2026-10-06T08:00:00.000Z";

const seedBot = (botId: PersonalBotId, extra: { readonly hidePreviews?: boolean } = {}) =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: `Bot ${botId}`,
        title: "",
        description: "",
        instructions: "",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        team: "assistant",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    if (extra.hidePreviews === true) {
      yield* sql`UPDATE personal_bots SET hide_previews = 1 WHERE bot_id = ${botId}`;
    }
  });

const seedChat = (input: {
  readonly botId: PersonalBotId;
  readonly id: string;
  readonly messages?: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly at: string;
  }>;
  readonly archivedThread?: boolean;
}) =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make(input.id);
    yield* repository.insertThreadLink(
      decodeInsertThreadLink({ botId: input.botId, threadId, createdAt: T0 }),
    );
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, archived_at)
      VALUES (${input.id}, 'project-1', ${input.id}, ${T0}, ${T0},
        ${input.archivedThread === true ? T0 : null})
    `;
    let n = 0;
    for (const message of input.messages ?? []) {
      n += 1;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${`${input.id}-m${String(n)}`}, ${input.id}, ${message.role}, ${message.text}, 0,
          ${message.at}, ${message.at})
      `;
    }
    return threadId;
  });

const link = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const links = yield* repository.listThreadLinks();
    return links.find((candidate) => candidate.threadId === threadId)!;
  });

const iso = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

it.live("pin: stored on the server, listed as pinnedAt, unpin clears it", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* seedBot(BOT);
    const threadId = yield* seedChat({
      botId: BOT,
      id: "t-pin",
      messages: [{ role: "assistant", text: "hi", at: "2026-10-06T08:01:00.000Z" }],
    });
    expect((yield* link(threadId)).pinnedAt).toBeUndefined();
    expect(
      yield* repository.updateThreadState({ threadId, pinnedAt: "2026-10-06T09:00:00.000Z" }),
    ).toBe(true);
    const pinned = yield* link(threadId);
    expect(iso(pinned.pinnedAt)).toBe("2026-10-06T09:00:00.000Z");
    expect(pinned.snoozedUntil).toBeUndefined();
    yield* repository.updateThreadState({ threadId, pinnedAt: null });
    expect((yield* link(threadId)).pinnedAt).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "snooze: a future snooze hides the preview and unread; wake now returns it unread at the top",
  () =>
    Effect.gen(function* () {
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      yield* seedBot(BOT);
      const threadId = yield* seedChat({
        botId: BOT,
        id: "t-snooze",
        messages: [
          { role: "user", text: "q", at: "2026-10-06T08:00:30.000Z" },
          { role: "assistant", text: "answer", at: "2026-10-06T08:01:00.000Z" },
        ],
      });
      // Seen (viewed after the reply), so only the wake can make it unread.
      yield* repository.recordThreadViewed({ threadId, viewedAt: "2026-10-06T08:02:00.000Z" });
      const farFuture = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3 * 3600_000),
      );
      yield* repository.updateThreadState({ threadId, snoozedUntil: farFuture });
      const snoozed = yield* link(threadId);
      expect(iso(snoozed.snoozedUntil)).toBe(farFuture);
      expect(snoozed.newestMessage).toBeNull();
      expect(snoozed.unread).toBeUndefined();

      // Wake now: the snooze ends at this moment, the chat is back with its
      // preview, unread, ordered as if a message arrived now.
      const wakeAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe())),
      );
      yield* repository.updateThreadState({ threadId, wakeAt });
      const awake = yield* link(threadId);
      expect(awake.snoozedUntil).toBeUndefined();
      expect(awake.newestMessage?.text).toBe("answer");
      expect(awake.unread).toBe(true);
      expect(awake.markedUnread).toBe(true);
      expect(iso(awake.lastReplyAt)).toBe(wakeAt);
      expect(iso(awake.lastActivityAt)).toBe(wakeAt);

      // Opening the chat clears it.
      yield* repository.recordThreadViewed({
        threadId,
        viewedAt: DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 1000),
        ),
      });
      expect((yield* link(threadId)).unread).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
);

it.live("snooze: a snooze that ran out is not listed, the chat is unread from its wake time", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* seedBot(BOT);
    const threadId = yield* seedChat({
      botId: BOT,
      id: "t-woke",
      messages: [{ role: "assistant", text: "old", at: "2026-10-06T08:01:00.000Z" }],
    });
    yield* repository.recordThreadViewed({ threadId, viewedAt: "2026-10-06T08:02:00.000Z" });
    yield* repository.updateThreadState({ threadId, snoozedUntil: "2026-10-06T08:30:00.000Z" });
    const woke = yield* link(threadId);
    expect(woke.snoozedUntil).toBeUndefined();
    expect(woke.unread).toBe(true);
    expect(woke.markedUnread).toBe(true);
    expect(iso(woke.lastReplyAt)).toBe("2026-10-06T08:30:00.000Z");
    expect(iso(woke.lastActivityAt)).toBe("2026-10-06T08:30:00.000Z");
  }).pipe(Effect.provide(testLayer)),
);

it.live("wake now does nothing to a chat that is not snoozed", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* seedBot(BOT);
    const threadId = yield* seedChat({
      botId: BOT,
      id: "t-nosnooze",
      messages: [{ role: "assistant", text: "x", at: "2026-10-06T08:01:00.000Z" }],
    });
    yield* repository.recordThreadViewed({ threadId, viewedAt: "2026-10-06T08:02:00.000Z" });
    yield* repository.updateThreadState({ threadId, wakeAt: "2026-10-06T09:00:00.000Z" });
    const after = yield* link(threadId);
    expect(after.unread).toBeUndefined();
    expect(after.markedUnread).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.live("mark unread: unread for any bot until the chat is opened again", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* seedBot(BOT);
    const threadId = yield* seedChat({
      botId: BOT,
      id: "t-mark",
      messages: [{ role: "assistant", text: "x", at: "2026-10-06T08:01:00.000Z" }],
    });
    yield* repository.recordThreadViewed({ threadId, viewedAt: "2026-10-06T08:02:00.000Z" });
    expect((yield* link(threadId)).unread).toBeUndefined();
    yield* repository.updateThreadState({ threadId, markedUnreadAt: "2026-10-06T08:10:00.000Z" });
    const marked = yield* link(threadId);
    expect(marked.unread).toBe(true);
    expect(marked.markedUnread).toBe(true);
    // Counts from 30 s after the mark, so the leave that follows marking from
    // inside the open chat (a viewed stamp a second or two later) does not read it.
    expect(iso(marked.lastReplyAt)).toBe("2026-10-06T08:10:30.000Z");
    yield* repository.recordThreadViewed({ threadId, viewedAt: "2026-10-06T08:10:02.000Z" });
    expect((yield* link(threadId)).unread).toBe(true);
    // The chat is opened again (viewed after the mark): read.
    yield* repository.recordThreadViewed({ threadId, viewedAt: "2026-10-06T08:11:00.000Z" });
    expect((yield* link(threadId)).unread).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.live(
  "pin, snooze and mark are refused for archived chats and group relays; archiving clears pin and snooze",
  () =>
    Effect.gen(function* () {
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* seedBot(BOT);
      const live = yield* seedChat({ botId: BOT, id: "t-live" });
      yield* repository.updateThreadState({ threadId: live, pinnedAt: T0 });
      yield* repository.updateThreadState({
        threadId: live,
        snoozedUntil: DateTime.formatIso(
          DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 3600_000),
        ),
      });
      yield* repository.setThreadArchived({
        threadId: live,
        archivedAt: DateTime.makeUnsafe("2026-10-06T10:00:00.000Z"),
      });
      const rows = yield* sql<{ readonly p: string | null; readonly s: string | null }>`
        SELECT pinned_at AS "p", snoozed_until AS "s" FROM personal_bot_threads WHERE thread_id = 't-live'
      `;
      expect(rows).toEqual([{ p: null, s: null }]);
      expect(yield* repository.updateThreadState({ threadId: live, pinnedAt: T0 })).toBe(false);

      const relay = yield* seedChat({ botId: BOT, id: "t-relay" });
      yield* sql`
        INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
        VALUES ('g-1', 'Team', 'g-thread', 8, ${T0}, ${T0})
      `;
      yield* sql`
        INSERT INTO personal_group_members (group_id, bot_id, thread_id, role, sort_order, joined_at)
        VALUES ('g-1', ${BOT}, 't-relay', 'member', 0, ${T0})
      `;
      expect(yield* repository.updateThreadState({ threadId: relay, pinnedAt: T0 })).toBe(false);
      // isGroupRelay: a member's relay thread, and nothing else.
      expect(yield* repository.isGroupRelay({ threadId: relay })).toBe(true);
      expect(yield* repository.isGroupRelay({ threadId: live })).toBe(false);
      expect(yield* repository.isGroupRelay({ threadId: ThreadId.make("nope") })).toBe(false);
      expect(
        yield* repository.updateThreadState({ threadId: ThreadId.make("nope"), pinnedAt: T0 }),
      ).toBe(false);
    }).pipe(Effect.provide(testLayer)),
);

it.live(
  "search: newest first, case-insensitive, skips reasoning, system, hidden-preview bots, relays and deleted chats",
  () =>
    Effect.gen(function* () {
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      const sql = yield* SqlClient.SqlClient;
      const hidden = PersonalBotId.make("bot-hidden");
      yield* seedBot(BOT);
      yield* seedBot(hidden, { hidePreviews: true });
      yield* seedChat({
        botId: BOT,
        id: "t-a",
        messages: [
          { role: "user", text: "Please ship the Release notes", at: "2026-10-06T08:01:00.000Z" },
          { role: "reasoning", text: "release thinking trace", at: "2026-10-06T08:01:30.000Z" },
          { role: "assistant", text: "the RELEASE is staged", at: "2026-10-06T08:02:00.000Z" },
        ],
      });
      yield* seedChat({
        botId: BOT,
        id: "t-b",
        archivedThread: true,
        messages: [{ role: "assistant", text: "old release", at: "2026-10-05T08:00:00.000Z" }],
      });
      yield* seedChat({
        botId: hidden,
        id: "t-hidden",
        messages: [{ role: "assistant", text: "secret release", at: "2026-10-06T08:03:00.000Z" }],
      });
      yield* seedChat({
        botId: BOT,
        id: "t-system",
        messages: [{ role: "system", text: "release settled", at: "2026-10-06T08:04:00.000Z" }],
      });
      yield* seedChat({
        botId: BOT,
        id: "t-deleted",
        messages: [{ role: "assistant", text: "deleted release", at: "2026-10-06T08:05:00.000Z" }],
      });
      yield* sql`UPDATE projection_threads SET deleted_at = ${T0} WHERE thread_id = 't-deleted'`;
      yield* seedChat({
        botId: BOT,
        id: "t-relay",
        messages: [{ role: "assistant", text: "relay release", at: "2026-10-06T08:06:00.000Z" }],
      });
      yield* sql`
        INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
        VALUES ('g-1', 'Team', 'g-thread', 8, ${T0}, ${T0})
      `;
      yield* sql`
        INSERT INTO personal_group_members (group_id, bot_id, thread_id, role, sort_order, joined_at)
        VALUES ('g-1', ${BOT}, 't-relay', 'member', 0, ${T0})
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('g-thread', 'project-1', 'Team', ${T0}, ${T0})
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('g-m1', 'g-thread', 'user', 'group release talk', 0,
          '2026-10-06T08:07:00.000Z', '2026-10-06T08:07:00.000Z')
      `;

      const rows = yield* repository.searchMessages({ needle: "release", limit: 50 });
      expect(rows.map((row) => row.messageId)).toEqual(["g-m1", "t-a-m3", "t-a-m1", "t-b-m1"]);
      expect(rows[0]).toMatchObject({ groupId: "g-1", botId: null, archived: false, role: "user" });
      expect(rows[1]).toMatchObject({ botId: BOT, groupId: null, archived: false });
      expect(rows[3]).toMatchObject({ botId: BOT, archived: true });
      expect(yield* repository.searchMessages({ needle: "zzz", limit: 50 })).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);

it.live("search: a group with a hidden-preview member is not searched", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const hidden = PersonalBotId.make("bot-hidden");
    yield* seedBot(hidden, { hidePreviews: true });
    yield* sql`
      INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
      VALUES ('g-1', 'Team', 'g-thread', 8, ${T0}, ${T0})
    `;
    yield* sql`
      INSERT INTO personal_group_members (group_id, bot_id, thread_id, role, sort_order, joined_at)
      VALUES ('g-1', ${hidden}, NULL, 'member', 0, ${T0})
    `;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES ('g-thread', 'project-1', 'Team', ${T0}, ${T0})
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('g-m1', 'g-thread', 'user', 'group release talk', 0, ${T0}, ${T0})
    `;
    expect(yield* repository.searchMessages({ needle: "release", limit: 10 })).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("search: a snippet is cut around the match in SQL", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* seedBot(BOT);
    const long = `${"a ".repeat(200)}NEEDLE${" b".repeat(200)}`;
    yield* seedChat({
      botId: BOT,
      id: "t-long",
      messages: [{ role: "assistant", text: long, at: "2026-10-06T08:01:00.000Z" }],
    });
    const [row] = yield* repository.searchMessages({ needle: "needle", limit: 5 });
    expect(row!.snippetStart).toBeGreaterThan(1);
    expect(row!.snippet.length).toBeLessThanOrEqual(200);
    expect(row!.snippet).toContain("NEEDLE");
    expect(snippetOf(row!).startsWith("…")).toBe(true);
    expect(snippetOf(row!).endsWith("…")).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it("snippetOf drops code fences and folds whitespace", () => {
  const fence = "`".repeat(3);
  expect(
    snippetOf({
      snippet: `Ready to ship?

${fence}choices
Yes, ship it
Not yet
${fence}`,
      snippetStart: 1,
    }),
  ).toBe("Ready to ship? Yes, ship it Not yet");
});

it("asciiLower folds ASCII only, like SQLite lower()", () => {
  expect(asciiLower("ÉCole RELEASE")).toBe("École release");
});

it("groupMessageSearchRows keeps one hit per chat, counts the rest, and says when it stopped", () => {
  const row = (messageId: string, threadId: string, at: string) => ({
    messageId,
    threadId,
    botId: "bot-1",
    groupId: null,
    role: "assistant" as const,
    createdAt: at,
    archived: false,
    snippet: "hello  world",
    snippetStart: 1,
  });
  const result = groupMessageSearchRows(
    [
      row("m3", "t1", "2026-10-06T08:03:00.000Z"),
      row("m2", "t1", "2026-10-06T08:02:00.000Z"),
      row("m1", "t2", "2026-10-06T08:01:00.000Z"),
      row("m0", "t3", "2026-10-06T08:00:00.000Z"),
    ],
    2,
    false,
  );
  expect(result.hits.map((hit) => [hit.messageId, hit.moreInChat])).toEqual([
    ["m3", 1],
    ["m1", 0],
  ]);
  expect(result.hits[0]!.snippet).toBe("hello world");
  expect(result.capped).toBe(true);
  expect(groupMessageSearchRows([], 2, true).capped).toBe(true);
  expect(PERSONAL_MESSAGE_SEARCH_RAW_ROWS).toBeGreaterThanOrEqual(100);
});
