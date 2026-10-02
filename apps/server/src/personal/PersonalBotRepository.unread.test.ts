import { PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";

const testLayer = PersonalBotRepository.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const decodeCreateBot = Schema.decodeSync(PersonalBotRepository.CreatePersonalBotInput);
const decodeInsertThreadLink = Schema.decodeSync(
  PersonalBotRepository.InsertPersonalBotThreadInput,
);

const BASELINE = "2026-10-02T09:00:00.000Z";
const botId = PersonalBotId.make("bot-cto");

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("isThreadRowUnread", () => {
  const row = (lastReplyAt: string | null, lastViewedAt: string | null, groupRelay = 0) => ({
    groupRelay,
    lastReplyAt: lastReplyAt === null ? null : at(lastReplyAt),
    lastViewedAt: lastViewedAt === null ? null : at(lastViewedAt),
  });

  it("is unread only when the newest reply is after the last view", () => {
    expect(
      PersonalBotRepository.isThreadRowUnread(
        row("2026-10-02T10:00:01.000Z", "2026-10-02T10:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      PersonalBotRepository.isThreadRowUnread(
        row("2026-10-02T10:00:00.000Z", "2026-10-02T10:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      PersonalBotRepository.isThreadRowUnread(
        row("2026-10-02T09:59:00.000Z", "2026-10-02T10:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("is never unread without a reply, without a baseline, or for a group relay", () => {
    expect(PersonalBotRepository.isThreadRowUnread(row(null, "2026-10-02T10:00:00.000Z"))).toBe(
      false,
    );
    expect(PersonalBotRepository.isThreadRowUnread(row("2026-10-02T10:00:00.000Z", null))).toBe(
      false,
    );
    expect(
      PersonalBotRepository.isThreadRowUnread(
        row("2026-10-02T10:00:01.000Z", "2026-10-02T10:00:00.000Z", 1),
      ),
    ).toBe(false);
  });
});

const setup = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  yield* repository.createBot(
    decodeCreateBot({
      botId,
      name: "CTO",
      title: "Lead",
      description: "Leads.",
      instructions: "Lead.",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
      team: "dev",
      lead: true,
      pinned: true,
      sortOrder: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    }),
  );
});

interface ChatFixture {
  readonly id: string;
  /** [role, created_at] per message. */
  readonly messages: ReadonlyArray<readonly [string, string]>;
  readonly viewedAt?: string;
  readonly archivedLink?: boolean;
  readonly archivedThread?: boolean;
  readonly deletedThread?: boolean;
  readonly relay?: boolean;
}

const addChat = (chat: ChatFixture) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* repository.insertThreadLink(
      decodeInsertThreadLink({
        botId,
        threadId: ThreadId.make(chat.id),
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    if (chat.archivedLink === true) {
      yield* sql`UPDATE personal_bot_threads SET archived_at = '2026-10-02T11:00:00.000Z' WHERE thread_id = ${chat.id}`;
    }
    if (chat.viewedAt !== undefined) {
      yield* repository.recordThreadViewed({
        threadId: ThreadId.make(chat.id),
        viewedAt: chat.viewedAt,
      });
    }
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, archived_at, deleted_at)
      VALUES (${chat.id}, 'project-1', ${chat.id}, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        ${chat.archivedThread === true ? "2026-10-02T11:00:00.000Z" : null},
        ${chat.deletedThread === true ? "2026-10-02T11:00:00.000Z" : null})
    `;
    let index = 0;
    for (const [role, createdAt] of chat.messages) {
      index += 1;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${`m-${chat.id}-${index}`}, ${chat.id}, ${role}, 'text', 0, ${createdAt}, ${createdAt})
      `;
    }
    if (chat.relay === true) {
      yield* sql`
        INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
        VALUES ('group-1', 'Team', 'group-thread-1', 8, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO personal_group_members (group_id, bot_id, thread_id, joined_at)
        VALUES ('group-1', ${botId}, ${chat.id}, '2026-10-01T00:00:00.000Z')
      `;
    }
  });

const setBaseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO personal_meta (key, value)
    VALUES (${PersonalBotRepository.PERSONAL_CHAT_UNREAD_SINCE_META_KEY}, ${BASELINE})
  `;
});

const unreadById = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const links = yield* repository.listThreadLinks();
  return Object.fromEntries(
    links.map((link) => [
      link.threadId,
      link.unread === true && link.lastReplyAt !== undefined
        ? DateTime.formatIso(link.lastReplyAt)
        : null,
    ]),
  );
});

it.effect("marks a chat unread when the bot replied after the owner last opened it", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* setBaseline;
    yield* addChat({
      id: "t-reply-after-view",
      viewedAt: "2026-10-02T10:00:00.000Z",
      messages: [
        ["user", "2026-10-02T09:59:00.000Z"],
        ["assistant", "2026-10-02T10:05:00.000Z"],
      ],
    });
    yield* addChat({
      id: "t-read",
      viewedAt: "2026-10-02T10:10:00.000Z",
      messages: [["assistant", "2026-10-02T10:05:00.000Z"]],
    });
    // The owner wrote after viewing, or the server added a system row: neither
    // is something to read.
    yield* addChat({
      id: "t-own-message",
      viewedAt: "2026-10-02T10:00:00.000Z",
      messages: [
        ["assistant", "2026-10-02T09:58:00.000Z"],
        ["user", "2026-10-02T10:05:00.000Z"],
        ["system", "2026-10-02T10:06:00.000Z"],
        ["reasoning", "2026-10-02T10:07:00.000Z"],
      ],
    });
    // Never opened: the baseline stands in for the last view.
    yield* addChat({
      id: "t-never-opened-old",
      messages: [["assistant", "2026-10-02T08:00:00.000Z"]],
    });
    yield* addChat({
      id: "t-never-opened-new",
      messages: [["assistant", "2026-10-02T09:30:00.000Z"]],
    });
    yield* addChat({ id: "t-empty", messages: [] });

    expect(yield* unreadById).toEqual({
      "t-reply-after-view": "2026-10-02T10:05:00.000Z",
      "t-read": null,
      "t-own-message": null,
      "t-never-opened-old": null,
      "t-never-opened-new": "2026-10-02T09:30:00.000Z",
      "t-empty": null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("never marks archived, deleted or group relay chats unread", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* setBaseline;
    const reply = [["assistant", "2026-10-02T10:05:00.000Z"]] as const;
    yield* addChat({ id: "t-archived-link", archivedLink: true, messages: reply });
    yield* addChat({ id: "t-archived-thread", archivedThread: true, messages: reply });
    yield* addChat({ id: "t-deleted-thread", deletedThread: true, messages: reply });
    yield* addChat({ id: "t-relay", relay: true, messages: reply });
    yield* addChat({ id: "t-open", messages: reply });

    expect(yield* unreadById).toEqual({
      "t-archived-link": null,
      "t-archived-thread": null,
      "t-deleted-thread": null,
      "t-relay": null,
      "t-open": "2026-10-02T10:05:00.000Z",
    });
  }).pipe(Effect.provide(testLayer)),
);

it.live("writes the unread baseline once and keeps it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    yield* setup;
    // Replies from before the feature ran never light up.
    yield* addChat({ id: "t-history", messages: [["assistant", "2020-01-01T00:00:00.000Z"]] });
    expect(yield* unreadById).toEqual({ "t-history": null });
    const read = sql<{ value: string }>`
      SELECT value FROM personal_meta
      WHERE key = ${PersonalBotRepository.PERSONAL_CHAT_UNREAD_SINCE_META_KEY}
    `;
    const first = yield* read;
    expect(first).toHaveLength(1);
    yield* repository.listThreadLinks();
    expect(yield* read).toEqual(first);
  }).pipe(Effect.provide(testLayer)),
);
