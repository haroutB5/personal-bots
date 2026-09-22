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

const threadId = ThreadId.make("thread-preview");

const insertMessage = (input: {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (${input.messageId}, ${threadId}, ${input.role}, ${input.text}, 0,
        ${input.createdAt}, ${input.createdAt})
    `;
  });

// A `reasoning` message is the provider's thinking trace, not something the bot
// said: it must never become the chats list preview.
it.effect("previews the newest message the chat shows, skipping traces", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const botId = PersonalBotId.make("bot-preview");
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: "Ada",
        title: "Assistant",
        description: "Helps.",
        instructions: "Be helpful.",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        team: "assistant",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: "2026-09-13T20:38:00.000Z",
        updatedAt: "2026-09-13T20:38:00.000Z",
      }),
    );
    yield* repository.insertThreadLink(
      decodeInsertThreadLink({ botId, threadId, createdAt: "2026-09-13T20:38:00.000Z" }),
    );
    yield* insertMessage({
      messageId: "m-assistant",
      role: "assistant",
      text: "Done.",
      createdAt: "2026-09-13T20:38:02.000Z",
    });
    yield* insertMessage({
      messageId: "m-reasoning",
      role: "reasoning",
      text: "Let me think about the auth flow.",
      createdAt: "2026-09-13T20:38:03.000Z",
    });
    yield* insertMessage({
      messageId: "m-system",
      role: "system",
      text: "Turn settled.",
      createdAt: "2026-09-13T20:38:04.000Z",
    });

    const links = yield* repository.listThreadLinks();
    expect(links).toHaveLength(1);
    expect(links[0]?.newestMessage).toMatchObject({ id: "m-assistant", role: "assistant" });
  }).pipe(Effect.provide(testLayer)),
);

// The Chats screen shows one preview per bot: its newest thread that is not
// archived, not deleted and not a group relay. Only the newest two such
// threads carry text (one of slack for a client a shell update behind); every
// other link ships without the 400-char preview.
it.effect("previews only each bot's two newest eligible chats", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const botId = PersonalBotId.make("bot-slim");
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: "Grace",
        title: "Assistant",
        description: "Helps.",
        instructions: "Be helpful.",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        team: "assistant",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: "2026-09-13T20:38:00.000Z",
        updatedAt: "2026-09-13T20:38:00.000Z",
      }),
    );
    // [thread, updatedAt, archived link, archived thread, group relay]
    const threads = [
      ["t-old", "2026-09-13T20:40:00.000Z", false, false, false],
      ["t-second", "2026-09-13T20:41:00.000Z", false, false, false],
      ["t-archived-link", "2026-09-13T20:45:00.000Z", true, false, false],
      ["t-archived-thread", "2026-09-13T20:46:00.000Z", false, true, false],
      ["t-relay", "2026-09-13T20:47:00.000Z", false, false, true],
      ["t-newest", "2026-09-13T20:44:00.000Z", false, false, false],
    ] as const;
    for (const [id, updatedAt, archivedLink, archivedThread, relay] of threads) {
      yield* repository.insertThreadLink(
        decodeInsertThreadLink({
          botId,
          threadId: ThreadId.make(id),
          createdAt: "2026-09-13T20:39:00.000Z",
        }),
      );
      if (archivedLink) {
        yield* sql`UPDATE personal_bot_threads SET archived_at = ${updatedAt} WHERE thread_id = ${id}`;
      }
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, archived_at)
        VALUES (${id}, 'project-1', ${id}, '2026-09-13T20:39:00.000Z', ${updatedAt},
          ${archivedThread ? updatedAt : null})
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${`m-${id}`}, ${id}, 'assistant', ${`text of ${id}`}, 0, ${updatedAt}, ${updatedAt})
      `;
      if (relay) {
        yield* sql`
          INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
          VALUES ('group-1', 'Team', 'group-thread-1', 8, ${updatedAt}, ${updatedAt})
        `;
        yield* sql`
          INSERT INTO personal_group_members (group_id, bot_id, thread_id, joined_at)
          VALUES ('group-1', ${botId}, ${id}, ${updatedAt})
        `;
      }
    }

    const links = yield* repository.listThreadLinks();
    const previews = Object.fromEntries(
      links.map((link) => [link.threadId, link.newestMessage?.text ?? null]),
    );
    expect(previews).toEqual({
      "t-old": null,
      "t-second": "text of t-second",
      "t-archived-link": null,
      "t-archived-thread": null,
      "t-relay": null,
      "t-newest": "text of t-newest",
    });
  }).pipe(Effect.provide(testLayer)),
);
