import { PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
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

const at = "2026-09-24T21:00:00.000Z";

interface ThreadOptions {
  readonly messages?: ReadonlyArray<string>;
  readonly archivedLink?: boolean;
  readonly archivedThread?: boolean;
  readonly deletedThread?: boolean;
}

// Group-only bots are hidden from Chats. What decides it is whether the bot has
// a private chat of its own, and a group's relay threads (current, left, or
// from a deleted group), an archived or deleted chat and an empty "New chat"
// must never count as one.
it.effect("derives group presence, ignoring relay threads and empty chats", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;

    const makeBot = (id: string) =>
      repository.createBot(
        decodeCreateBot({
          botId: PersonalBotId.make(id),
          name: id,
          title: "",
          description: "",
          instructions: "",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
          team: "dev",
          lead: false,
          pinned: false,
          sortOrder: 0,
          createdAt: at,
          updatedAt: at,
        }),
      );

    const makeThread = (botId: string, id: string, options: ThreadOptions = {}) =>
      Effect.gen(function* () {
        yield* repository.insertThreadLink(
          decodeInsertThreadLink({ botId, threadId: ThreadId.make(id), createdAt: at }),
        );
        if (options.archivedLink === true) {
          yield* sql`UPDATE personal_bot_threads SET archived_at = ${at} WHERE thread_id = ${id}`;
        }
        const archivedAt = options.archivedThread === true ? at : null;
        const deletedAt = options.deletedThread === true ? at : null;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, created_at, updated_at, archived_at, deleted_at
          ) VALUES (${id}, 'project-1', ${id}, ${at}, ${at}, ${archivedAt}, ${deletedAt})
        `;
        let index = 0;
        for (const role of options.messages ?? []) {
          const messageId = `${id}-m${String(index)}`;
          index += 1;
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id, thread_id, role, text, is_streaming, created_at, updated_at
            ) VALUES (${messageId}, ${id}, ${role}, 'hi', 0, ${at}, ${at})
          `;
        }
      });

    const makeGroup = (groupId: string, archived: boolean, deleted: boolean) => {
      const archivedAt = archived ? at : null;
      const deletedAt = deleted ? at : null;
      const threadId = `${groupId}-thread`;
      return sql`
        INSERT INTO personal_groups (
          group_id, name, thread_id, max_bot_turns, created_at, updated_at, archived_at, deleted_at
        ) VALUES (${groupId}, ${groupId}, ${threadId}, 8, ${at}, ${at}, ${archivedAt}, ${deletedAt})
      `;
    };

    const join = (groupId: string, botId: string, relayThreadId: string, left: boolean) => {
      const leftAt = left ? at : null;
      return sql`
        INSERT INTO personal_group_members (group_id, bot_id, thread_id, joined_at, left_at)
        VALUES (${groupId}, ${botId}, ${relayThreadId}, ${at}, ${leftAt})
      `;
    };

    yield* makeGroup("lunas", false, false);
    yield* makeGroup("old", false, true);
    yield* makeGroup("shelved", true, false);

    // Luna: a busy relay thread, an empty "New chat" and a reasoning-only one.
    yield* makeBot("luna");
    yield* makeThread("luna", "luna-relay", { messages: ["user", "assistant"] });
    yield* join("lunas", "luna", "luna-relay", false);
    yield* makeThread("luna", "luna-empty");
    yield* makeThread("luna", "luna-trace", { messages: ["reasoning", "system"] });
    // Relays from a group it left and from a deleted group are still relays.
    yield* makeThread("luna", "luna-left-relay", { messages: ["assistant"] });
    yield* join("shelved", "luna", "luna-left-relay", true);
    yield* makeThread("luna", "luna-old-relay", { messages: ["assistant"] });
    yield* join("old", "luna", "luna-old-relay", false);
    // Archived and deleted chats do not count either.
    yield* makeThread("luna", "luna-archived", { messages: ["user"], archivedLink: true });
    yield* makeThread("luna", "luna-archived-thread", {
      messages: ["user"],
      archivedThread: true,
    });
    yield* makeThread("luna", "luna-deleted", { messages: ["user"], deletedThread: true });

    // Sol: in the group and also talked to privately.
    yield* makeBot("sol");
    yield* makeThread("sol", "sol-relay", { messages: ["assistant"] });
    yield* join("lunas", "sol", "sol-relay", false);
    yield* makeThread("sol", "sol-private", { messages: ["user"] });

    // Ada: in no group at all.
    yield* makeBot("ada");

    // Vega: only in an archived group and a deleted one, so in no live group.
    yield* makeBot("vega");
    yield* makeThread("vega", "vega-relay");
    yield* join("shelved", "vega", "vega-relay", false);
    yield* makeThread("vega", "vega-old-relay");
    yield* join("old", "vega", "vega-old-relay", false);

    // Deleted bots are never listed.
    yield* makeBot("gone");
    yield* sql`UPDATE personal_bots SET deleted_at = ${at} WHERE bot_id = 'gone'`;

    const presence = yield* repository.listGroupPresence();
    expect(
      Object.fromEntries(
        presence.map((row) => [row.botId, { groups: row.groupIds, chat: row.hasPrivateChat }]),
      ),
    ).toEqual({
      ada: { groups: [], chat: false },
      luna: { groups: ["lunas"], chat: false },
      sol: { groups: ["lunas"], chat: true },
      vega: { groups: [], chat: false },
    });

    // The first message in the empty chat makes it a private chat: Luna is back.
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('first', 'luna-empty', 'user', 'hello', 0, ${at}, ${at})
    `;
    const afterMessage = yield* repository.listGroupPresence();
    expect(afterMessage.find((row) => row.botId === "luna")?.hasPrivateChat).toBe(true);

    // Deleting that chat hides it again.
    yield* sql`UPDATE projection_threads SET deleted_at = ${at} WHERE thread_id = 'luna-empty'`;
    const afterDelete = yield* repository.listGroupPresence();
    expect(afterDelete.find((row) => row.botId === "luna")?.hasPrivateChat).toBe(false);
  }).pipe(Effect.provide(testLayer)),
);
