import { PersonalBotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
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

// The bot form's "Allow voice calls": off for a new bot, and the switch round-trips.
it.effect("stores the Allow voice calls switch, off unless asked for", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const quiet = PersonalBotId.make("bot-quiet");
    const callable = PersonalBotId.make("bot-callable");
    const base = {
      name: "Ada",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob" as const,
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
      team: "assistant",
      lead: false,
      pinned: false,
      sortOrder: 0,
      createdAt: "2026-10-15T17:00:00.000Z",
      updatedAt: "2026-10-15T17:00:00.000Z",
    };
    yield* repository.createBot(decodeCreateBot({ ...base, botId: quiet }));
    yield* repository.createBot(
      decodeCreateBot({ ...base, botId: callable, allowVoiceCalls: true }),
    );

    const bots = yield* repository.listBots();
    const byId = new Map(bots.map((bot) => [bot.botId, bot]));
    expect(byId.get(quiet)?.allowVoiceCalls).toBe(false);
    expect(byId.get(callable)?.allowVoiceCalls).toBe(true);

    yield* repository.updateBot({
      botId: quiet,
      allowVoiceCalls: true,
      updatedAt: DateTime.makeUnsafe("2026-10-15T17:01:00.000Z"),
    });
    const after = yield* repository.getBotById({ botId: quiet });
    expect(after.pipe(Option.getOrThrow).allowVoiceCalls).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

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

// The owner's "Hide message previews" switch: the list sends no text and no
// context marker for that bot, only that a message exists and is hidden.
it.effect("a bot with hidden previews sends no message text over the list", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const botId = PersonalBotId.make("bot-hidden");
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: "CFO scheduler",
        title: "Finance",
        description: "Watches money.",
        instructions: "Be careful.",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        team: "assistant",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: "2026-10-05T20:38:00.000Z",
        updatedAt: "2026-10-05T20:38:00.000Z",
      }),
    );
    yield* repository.insertThreadLink(
      decodeInsertThreadLink({ botId, threadId, createdAt: "2026-10-05T20:38:00.000Z" }),
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, context_json, is_streaming, created_at, updated_at
      ) VALUES ('m-secret', ${threadId}, 'assistant',
        'No alerts. Portfolio £27,636 at 21:06 (Kraken)',
        '{"version":1,"records":[{"kind":"personal-task-turn","title":"Kraken check"}]}', 0,
        '2026-10-05T20:38:02.000Z', '2026-10-05T20:38:02.000Z')
    `;

    const shown = yield* repository.listThreadLinks();
    expect(shown[0]?.newestMessage).toMatchObject({
      id: "m-secret",
      text: "No alerts. Portfolio £27,636 at 21:06 (Kraken)",
    });
    expect(shown[0]?.newestMessage?.hidden).toBeUndefined();

    yield* repository.updateBot({
      botId,
      hidePreviews: true,
      updatedAt: DateTime.makeUnsafe("2026-10-05T20:40:00.000Z"),
    });
    const hidden = yield* repository.listThreadLinks();
    expect(hidden[0]?.newestMessage).toEqual({
      id: "m-secret",
      role: "assistant",
      text: "",
      hidden: true,
    });

    yield* repository.updateBot({
      botId,
      hidePreviews: false,
      updatedAt: DateTime.makeUnsafe("2026-10-05T20:41:00.000Z"),
    });
    const back = yield* repository.listThreadLinks();
    expect(back[0]?.newestMessage?.text).toContain("Portfolio");
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

// 28 Sep: upstream's auto-settle settled two 3-day-old chats and stamped their
// updated_at, and they jumped to the top of the Bots list. The list ranks and
// reports chats by their last message, never by updated_at.
it.effect("ranks previews and reports lastActivityAt by the last message, not updated_at", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const botId = PersonalBotId.make("bot-activity");
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: "Backend",
        title: "Engineer",
        description: "Builds.",
        instructions: "Be helpful.",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        team: "assistant",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: "2026-09-25T19:00:00.000Z",
        updatedAt: "2026-09-25T19:00:00.000Z",
      }),
    );
    // [thread, last message, updated_at]
    const threads = [
      // Settled three days after its last turn: updated_at moved, nothing was said.
      ["t-settled", "2026-09-25T20:09:17.316Z", "2026-09-28T20:10:05.321Z"],
      ["t-recent-a", "2026-09-28T18:00:00.000Z", "2026-09-28T18:00:00.000Z"],
      ["t-recent-b", "2026-09-28T19:00:00.000Z", "2026-09-28T19:00:00.000Z"],
      // Opened but never written in: falls back to when it was made.
      ["t-empty", null, "2026-09-28T20:17:00.000Z"],
    ] as const;
    for (const [id, messageAt, updatedAt] of threads) {
      yield* repository.insertThreadLink(
        decodeInsertThreadLink({
          botId,
          threadId: ThreadId.make(id),
          createdAt: "2026-09-25T19:56:00.000Z",
        }),
      );
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${id}, 'project-1', ${id}, '2026-09-25T19:56:00.000Z', ${updatedAt})
      `;
      if (messageAt !== null) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (${`m-${id}`}, ${id}, 'assistant', ${`text of ${id}`}, 0, ${messageAt}, ${updatedAt})
        `;
      }
    }

    const links = yield* repository.listThreadLinks();
    const byId = new Map(links.map((link) => [link.threadId as string, link]));
    // The newest two by conversation get a preview; the settled one does not.
    expect(byId.get("t-recent-b")?.newestMessage?.text).toBe("text of t-recent-b");
    expect(byId.get("t-recent-a")?.newestMessage?.text).toBe("text of t-recent-a");
    expect(byId.get("t-settled")?.newestMessage ?? null).toBeNull();
    const activity = Object.fromEntries(
      links.map((link) => [
        link.threadId,
        link.lastActivityAt == null ? null : DateTime.formatIso(link.lastActivityAt),
      ]),
    );
    expect(activity).toEqual({
      "t-settled": "2026-09-25T20:09:17.316Z",
      "t-recent-a": "2026-09-28T18:00:00.000Z",
      "t-recent-b": "2026-09-28T19:00:00.000Z",
      "t-empty": "2026-09-25T19:56:00.000Z",
    });
  }).pipe(Effect.provide(testLayer)),
);

// The chat-chip row promotes a task chat the owner took over, and the server's
// rule for that is `lastOwnerMessageAt`, the same one the 48 h archive sweep
// uses: the owner's own newest message, never an app-written `personal-...`
// turn (a task brief, a steer, an auto-continue, a release notice). Task and
// routine chats get those constantly, so reading the thread's newest user
// message instead would make every one of them a permanent chip.
it.effect("reports the owner's own newest message, never an app-written turn", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const botId = PersonalBotId.make("bot-owner-message");
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: "CTO",
        title: "Chief",
        description: "Runs the team.",
        instructions: "Be helpful.",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        team: "assistant",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: "2026-09-25T19:00:00.000Z",
        updatedAt: "2026-09-25T19:00:00.000Z",
      }),
    );
    for (const id of ["t-owner", "t-app-only", "t-none"] as const) {
      yield* repository.insertThreadLink(
        decodeInsertThreadLink({
          botId,
          threadId: ThreadId.make(id),
          createdAt: "2026-09-25T19:56:00.000Z",
        }),
      );
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${id}, 'project-1', ${id}, '2026-09-25T19:56:00.000Z', '2026-09-25T19:56:00.000Z')
      `;
    }
    const message = (id: string, messageId: string, role: string, createdAt: string) => sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (${messageId}, ${id}, ${role}, 'text', 0, ${createdAt}, ${createdAt})
    `;
    // The owner wrote twice; the newest one wins. An app-written turn in
    // between must not: its message id starts with `personal-`.
    yield* message("t-owner", "owner-1", "user", "2026-09-25T20:00:00.000Z");
    yield* message("t-owner", "personal-task-brief-owner", "user", "2026-09-25T20:05:00.000Z");
    yield* message("t-owner", "owner-2", "user", "2026-09-25T20:10:00.000Z");
    // Only app-written turns landed here: the owner never wrote in it.
    yield* message("t-app-only", "personal-task-brief", "user", "2026-09-25T20:20:00.000Z");
    yield* message("t-app-only", "personal-relay-1", "assistant", "2026-09-25T20:21:00.000Z");

    const byId = new Map(
      (yield* repository.listThreadLinks()).map((link) => [link.threadId as string, link]),
    );
    const ownerAt = (id: string) => {
      const at = byId.get(id)?.lastOwnerMessageAt;
      return at == null ? null : DateTime.formatIso(at);
    };
    expect(ownerAt("t-owner")).toBe("2026-09-25T20:10:00.000Z");
    expect(ownerAt("t-app-only")).toBeNull();
    expect(ownerAt("t-none")).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "skips the owner's newest message on an archived link, unless the kill switch is set",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      const botId = PersonalBotId.make("bot-owner-archived");
      yield* repository.createBot(
        decodeCreateBot({
          botId,
          name: "CTO",
          title: "Chief",
          description: "Runs the team.",
          instructions: "Be helpful.",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
          team: "assistant",
          lead: false,
          pinned: false,
          sortOrder: 0,
          createdAt: "2026-09-25T19:00:00.000Z",
          updatedAt: "2026-09-25T19:00:00.000Z",
        }),
      );
      for (const id of ["t-open", "t-archived"] as const) {
        yield* repository.insertThreadLink(
          decodeInsertThreadLink({
            botId,
            threadId: ThreadId.make(id),
            createdAt: "2026-09-25T19:56:00.000Z",
          }),
        );
        yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${id}, 'project-1', ${id}, '2026-09-25T19:56:00.000Z', '2026-09-25T19:56:00.000Z')
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${`owner-${id}`}, ${id}, 'user', 'text', 0, '2026-09-25T20:00:00.000Z', '2026-09-25T20:00:00.000Z')
      `;
      }
      yield* sql`UPDATE personal_bot_threads SET archived_at = '2026-09-26T00:00:00.000Z' WHERE thread_id = 't-archived'`;

      const ownerAt = (
        links: ReadonlyArray<{
          readonly threadId: string;
          readonly lastOwnerMessageAt?: DateTime.Utc | null | undefined;
        }>,
        id: string,
      ) => {
        const at = links.find((link) => link.threadId === id)?.lastOwnerMessageAt;
        return at == null ? null : DateTime.formatIso(at);
      };
      const guarded = yield* repository.listThreadLinks();
      const previous = process.env.PB_PERF_OFF;
      process.env.PB_PERF_OFF = "owner-message-active-links";
      const unguarded = yield* repository.listThreadLinks().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) Reflect.deleteProperty(process.env, "PB_PERF_OFF");
            else process.env.PB_PERF_OFF = previous;
          }),
        ),
      );
      expect(ownerAt(guarded, "t-open")).toBe("2026-09-25T20:00:00.000Z");
      expect(ownerAt(guarded, "t-archived")).toBeNull();
      expect(ownerAt(unguarded, "t-open")).toBe("2026-09-25T20:00:00.000Z");
      expect(ownerAt(unguarded, "t-archived")).toBe("2026-09-25T20:00:00.000Z");
    }).pipe(Effect.provide(testLayer)),
);

// The Performance tab's sampler: a running provider CLI carries its session
// id on the command line, and this is the map back to the bot's name.
it.effect("lists each bot chat's provider session for process attribution", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const botId = PersonalBotId.make("bot-perf");
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: "Atlas",
        title: "Lead",
        description: "Leads.",
        instructions: "Lead well.",
        avatarShape: "roundedHexagon",
        avatarColor: "#7C3AED",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        },
        team: "dev",
        lead: true,
        pinned: false,
        sortOrder: 0,
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
      }),
    );
    const perfThread = ThreadId.make("thread-perf");
    yield* repository.insertThreadLink(
      decodeInsertThreadLink({
        botId,
        threadId: perfThread,
        createdAt: "2026-10-13T00:00:00.000Z",
      }),
    );
    // A real Claude row: the session id the CLI carries lives in the cursor,
    // not in `projection_thread_sessions.provider_session_id` (empty on live,
    // which is what made the tab attribute nothing).
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json
      )
      VALUES (
        ${perfThread}, 'claudeAgent', 'claudeAgent', 'full-access', 'running',
        '2026-10-13T00:01:00.000Z',
        '{"threadId":"thread-perf","resume":"d74b867f-dfb5-4e23-bb85-7deac41c86c4","resumeSessionAt":"1a874895-d0db-41d7-8b94-fa1ed16f35e3"}'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
      VALUES (${perfThread}, 'running', '2026-10-13T00:01:00.000Z')
    `;
    // A chat with no session row (nothing running) stays out; so does an
    // archived one, and one whose bot was deleted.
    const idleThread = ThreadId.make("thread-perf-idle");
    yield* repository.insertThreadLink(
      decodeInsertThreadLink({
        botId,
        threadId: idleThread,
        createdAt: "2026-10-13T00:00:00.000Z",
      }),
    );
    const archivedThread = ThreadId.make("thread-perf-archived");
    yield* repository.insertThreadLink(
      decodeInsertThreadLink({
        botId,
        threadId: archivedThread,
        createdAt: "2026-10-13T00:00:00.000Z",
      }),
    );
    yield* sql`
      UPDATE personal_bot_threads SET archived_at = '2026-10-13T00:02:00.000Z'
      WHERE thread_id = ${archivedThread}
    `;
    // The archived chat has a running Codex session of its own, and stays out.
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json
      )
      VALUES (
        ${archivedThread}, 'codex', 'codex', 'full-access', 'running',
        '2026-10-13T00:01:00.000Z', '{"threadId":"01a13577-61ae-7c22-93fa-9c636f634c89"}'
      )
    `;

    const sessions = yield* repository.listBotProviderSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.botName).toBe("Atlas");
    expect(sessions[0]?.threadId).toBe("thread-perf");
    expect(sessions[0]?.providerName).toBe("claudeAgent");
    expect(sessions[0]?.resumeCursorJson).toContain(
      '"resume":"d74b867f-dfb5-4e23-bb85-7deac41c86c4"',
    );
  }).pipe(Effect.provide(testLayer)),
);

// 1.66.49 finding 3: a schedule_json that does not decode used to be skipped
// silently. It still does not fail the read, but it logs one WARN with the bot
// id (once, not on every list refresh).
it.effect("warns once for a bot whose stored schedule_json cannot be decoded", () => {
  const lines: Array<{
    readonly level: string;
    readonly text: string;
    readonly fields: Record<string, unknown>;
  }> = [];
  const sink = Logger.make<unknown, void>(({ logLevel, message }) => {
    const [text, fields] = Array.isArray(message) ? message : [message, {}];
    lines.push({
      level: logLevel,
      text: String(text),
      fields: (fields ?? {}) as Record<string, unknown>,
    });
  });
  return Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const botId = PersonalBotId.make("bot-bad-schedule");
    yield* repository.createBot(
      decodeCreateBot({
        botId,
        name: "Scheduler",
        title: "Ops",
        description: "Runs at night.",
        instructions: "Be brief.",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-5-5",
        },
        team: "assistant",
        lead: false,
        pinned: false,
        sortOrder: 0,
        createdAt: "2026-10-15T20:38:00.000Z",
        updatedAt: "2026-10-15T20:38:00.000Z",
      }),
    );
    yield* sql`
      UPDATE personal_bots SET schedule_json = '{"enabled":true,"from":"22:00"'
      WHERE bot_id = ${botId}
    `;

    // Twice: the read still returns the bot (schedule off), and the warning is
    // not repeated for the same stored value.
    const first = yield* repository.listBots();
    const second = yield* repository.listBots();

    expect(first.map((bot) => bot.botId)).toContain(botId);
    expect(first.find((bot) => bot.botId === botId)?.schedule).toBeUndefined();
    expect(second).toHaveLength(first.length);
    // One line, naming the bot both ways: the server's text log prints only the
    // message, and the annotation is what structured readers see.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "Warn",
      text: expect.stringContaining("bot-bad-schedule"),
      fields: expect.objectContaining({ botId: "bot-bad-schedule" }),
    });
  }).pipe(
    Effect.provide(Layer.merge(testLayer, Logger.layer([sink], { mergeWithExisting: false }))),
  );
});
