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
