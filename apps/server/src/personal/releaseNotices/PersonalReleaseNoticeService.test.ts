// @effect-diagnostics nodeBuiltinImport:off - writes notice files into the test server's inbox like notify-release.ps1 does.
// @effect-diagnostics preferSchemaOverJson:off - writes the notice JSON verbatim, as the script does.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskChatArchive from "../PersonalTaskChatArchiveService.ts";
import {
  PersonalReleaseNotices,
  RELEASE_NOTICE_DIR,
  layer as releaseNoticeLayer,
} from "./PersonalReleaseNoticeService.ts";

const CTO_CHAT = "thread-cto-chat";
const PLAIN_THREAD = "thread-not-a-bot";

/** What the projection says about the chats of a test: title and archive flag. */
const shells = new Map<string, { title: string; archivedAt: string | null }>();

const makeLayer = (dispatched: Array<OrchestrationCommand>) =>
  releaseNoticeLayer.pipe(
    Layer.provideMerge(PersonalTaskChatArchive.layer),
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === CTO_CHAT || threadId === PLAIN_THREAD || shells.has(threadId)
              ? Option.some({
                  id: threadId,
                  title: shells.get(threadId)?.title ?? "Main",
                  archivedAt: shells.get(threadId)?.archivedAt ?? null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
                })
              : Option.none(),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-release-notice-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** The CTO's chat is a bot chat; PLAIN_THREAD is an ordinary T3 thread. */
const linkCtoChat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO personal_bots (
      bot_id, name, description, instructions, avatar_shape, avatar_color,
      model_selection_json, enabled, sort_order, created_at, updated_at
    )
    VALUES ('bot-cto', 'CTO', '', '', 'blob', '#1A73E8', '{"instanceId":"claudeAgent","model":"claude-sonnet-5-5"}', 1, 0, ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
    VALUES (${CTO_CHAT}, 'bot-cto', ${now})
  `;
});

const inboxDir = Effect.map(ServerConfig.ServerConfig, (config) =>
  NodePath.join(config.baseDir, "personal", RELEASE_NOTICE_DIR),
);

/** What notify-release.ps1 writes. */
const writeNotice = (name: string, body: Record<string, unknown>) =>
  Effect.gen(function* () {
    const dir = yield* inboxDir;
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(dir, { recursive: true });
      // PowerShell's UTF-8 writer may add a BOM; the server must accept it.
      await NodeFSP.writeFile(NodePath.join(dir, name), `\uFEFF${JSON.stringify(body)}\n`);
    });
  });

const turnStarts = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );

describe("PersonalReleaseNotices", () => {
  it.effect("a successful release posts exactly one turn into the requesting chat", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      yield* linkCtoChat;
      yield* writeNotice("20261001T230000Z-live.json", {
        threadId: CTO_CHAT,
        version: "1.60.18",
        release: "abc123def456",
        outcome: "live",
        smokeExit: 0,
        rollbackRelease: "5531a1f12aeb",
        logPath: "C:\\Users\\Ht\\.personal-bots\\logs\\restart-1.60.18.log",
      });
      const service = yield* PersonalReleaseNotices;
      const first = yield* service.sweep;
      const second = yield* service.sweep;

      expect(first).toEqual([{ status: "posted", threadId: CTO_CHAT }]);
      expect(second).toEqual([]);
      const turns = turnStarts(dispatched);
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      expect(turn.threadId).toBe(CTO_CHAT);
      expect(turn.message.messageId).toBe("personal-notice-release-20261001T230000Z-live");
      expect(turn.message.text).toContain(
        "Release landed: hbots 1.60.18 (release abc123def456) is live. Smoke exit 0. No rollback.",
      );
      expect(turn.message.text).toContain("restart-1.60.18.log");
      expect(turn.message.text).toContain("start QA now");
      expect(turn.message.context?.records[0]).toMatchObject({
        kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
        payload: { notice: "release-landed" },
      });
      // The chat's own modes: a changed runtime mode would restart its session.
      expect(turn.runtimeMode).toBe("full-access");
      expect(turn.interactionMode).toBe("default");
      const dir = yield* inboxDir;
      const posted = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "posted")));
      expect(posted).toEqual(["20261001T230000Z-live.json"]);
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });

  it.effect("a rollback posts exactly one turn with the rollback status", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      yield* linkCtoChat;
      yield* writeNotice("20261001T231500Z-rollback.json", {
        threadId: CTO_CHAT,
        version: "1.60.18",
        release: "abc123def456",
        outcome: "rolled_back",
        smokeExit: 1,
        rollbackRelease: "5531a1f12aeb",
        rollbackExit: 0,
        rollbackSmokeExit: 0,
        logPath: "C:\\logs\\restart-1.60.18.log",
        detail: "FAIL  /version.txt mismatch",
      });
      const service = yield* PersonalReleaseNotices;
      yield* service.sweep;
      yield* service.sweep;

      const turns = turnStarts(dispatched);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.message.text).toContain(
        "failed its smoke (exit 1) and was rolled back to 5531a1f12aeb: rollback exit 0, rollback smoke exit 0.",
      );
      expect(turns[0]!.message.text).toContain("Detail: FAIL  /version.txt mismatch");
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });

  it.effect("no thread id, a plain thread or a broken file posts nothing", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      yield* linkCtoChat;
      const base = { version: "1.60.18", release: "abc123def456", outcome: "live", smokeExit: 0 };
      yield* writeNotice("a-no-thread.json", base);
      yield* writeNotice("b-empty-thread.json", { ...base, threadId: "  " });
      yield* writeNotice("c-plain-thread.json", { ...base, threadId: PLAIN_THREAD });
      yield* writeNotice("d-unknown-thread.json", { ...base, threadId: "thread-gone" });
      yield* writeNotice("e-bad-outcome.json", { ...base, threadId: CTO_CHAT, outcome: "maybe" });
      const service = yield* PersonalReleaseNotices;
      const outcomes = yield* service.sweep;

      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
      ]);
      expect(dispatched).toEqual([]);
      const dir = yield* inboxDir;
      const rejected = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "rejected")));
      expect(rejected).toHaveLength(5);
      expect(yield* service.sweep).toEqual([]);
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });

  describe("a chat that was archived or deleted never takes the notice back", () => {
    const BASE = { version: "1.66.8", release: "abc123def456", outcome: "live", smokeExit: 0 };
    const ARCHIVED_MAIN = "thread-main-archived";

    interface ChatSeed {
      readonly id: string;
      readonly title: string;
      readonly archived?: boolean;
      /** Last message time; later is more recently active. */
      readonly lastMessageAt?: string;
      readonly taskChat?: boolean;
      /** Deleted: no link row and no shell, only the soft-deleted projection row and its task. */
      readonly deleted?: boolean;
    }

    const seedChats = (chats: ReadonlyArray<ChatSeed>) =>
      Effect.gen(function* () {
        shells.clear();
        const sql = yield* SqlClient.SqlClient;
        const created = "2026-10-08T09:00:00.000Z";
        for (const chat of chats) {
          if (chat.deleted !== true) {
            yield* sql`
              INSERT INTO personal_bot_threads (thread_id, bot_id, created_at, archived_at)
              VALUES (${chat.id}, 'bot-cto', ${created}, ${chat.archived === true ? "2026-10-08T10:00:00.000Z" : null})
            `;
            shells.set(chat.id, { title: chat.title, archivedAt: null });
          }
          yield* sql`
            INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
            VALUES (${chat.id}, 'project', ${chat.title}, ${created}, ${created}, ${chat.deleted === true ? created : null})
          `;
          if (chat.lastMessageAt !== undefined) {
            yield* sql`
              INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
              VALUES (${`${chat.id}-m`}, ${chat.id}, 'user', 'hi', 0, ${chat.lastMessageAt}, ${chat.lastMessageAt})
            `;
          }
          if (chat.taskChat === true || chat.deleted === true) {
            yield* sql`
              INSERT INTO personal_tasks (
                task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective, status,
                source, idempotency_key, depth, max_depth, max_children, created_at, updated_at
              )
              VALUES (
                ${`${chat.id}-task`}, ${`${chat.id}-task`}, NULL, 'bot-cto', ${chat.id}, 'Task', 'Do it', 'completed',
                ${chat.deleted === true ? "user" : "delegation"}, ${`${chat.id}-task`}, 0, 3, 4,
                ${chat.deleted === true ? created : "2026-10-08T08:59:00.000Z"}, ${created}
              )
            `;
          }
        }
      });

    const archivedState = (id: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ readonly archivedAt: string | null }>`
          SELECT archived_at AS "archivedAt" FROM personal_bot_threads WHERE thread_id = ${id}
        `;
        return row?.archivedAt ?? null;
      });

    const run = (chats: ReadonlyArray<ChatSeed>, target: string) =>
      Effect.gen(function* () {
        yield* linkCtoChat;
        yield* seedChats(chats);
        yield* writeNotice("20261008T120000Z-live.json", { ...BASE, threadId: target });
        const service = yield* PersonalReleaseNotices;
        return yield* service.sweep;
      });

    /** The rename a notice must never cause. */
    const renames = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
      dispatched.filter((command) => command.type === "thread.meta.update");

    it.effect(
      "goes to the bot's open chat with the same name; the archived chat stays archived and keeps its name",
      () => {
        const dispatched: Array<OrchestrationCommand> = [];
        return Effect.gen(function* () {
          const outcomes = yield* run(
            [
              { id: ARCHIVED_MAIN, title: "Main", archived: true },
              { id: "thread-main-new", title: "Main", lastMessageAt: "2026-10-08T10:30:00.000Z" },
              { id: "thread-other", title: "hbots", lastMessageAt: "2026-10-08T11:30:00.000Z" },
            ],
            ARCHIVED_MAIN,
          );

          expect(outcomes).toEqual([{ status: "posted", threadId: "thread-main-new" }]);
          expect(turnStarts(dispatched).map((turn) => turn.threadId)).toEqual(["thread-main-new"]);
          expect(turnStarts(dispatched)[0]!.message.text).toContain("Release landed");
          // Still archived, still called "Main", nothing renamed or unarchived.
          expect(yield* archivedState(ARCHIVED_MAIN)).not.toBeNull();
          expect(shells.get(ARCHIVED_MAIN)?.title).toBe("Main");
          expect(renames(dispatched)).toEqual([]);
          expect(dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
        }).pipe(Effect.provide(makeLayer(dispatched)));
      },
    );

    it.effect("with several open chats of that name, the most recently active one takes it", () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const outcomes = yield* run(
          [
            { id: ARCHIVED_MAIN, title: "Main", archived: true },
            { id: "main-old", title: "Main", lastMessageAt: "2026-10-01T10:00:00.000Z" },
            { id: "main-busy", title: " main ", lastMessageAt: "2026-10-08T11:45:00.000Z" },
            { id: "main-mid", title: "Main", lastMessageAt: "2026-10-05T10:00:00.000Z" },
          ],
          ARCHIVED_MAIN,
        );
        expect(outcomes).toEqual([{ status: "posted", threadId: "main-busy" }]);
      }).pipe(Effect.provide(makeLayer(dispatched)));
    });

    it.effect(
      "with no open chat of that name, the bot's most recently active conversation takes it, not a task chat",
      () => {
        const dispatched: Array<OrchestrationCommand> = [];
        return Effect.gen(function* () {
          const outcomes = yield* run(
            [
              { id: ARCHIVED_MAIN, title: "Main", archived: true },
              { id: "hbots", title: "hbots", lastMessageAt: "2026-10-08T09:30:00.000Z" },
              { id: "matchday", title: "matchday", lastMessageAt: "2026-10-08T11:00:00.000Z" },
              {
                id: "task-chat",
                title: "Build it",
                lastMessageAt: "2026-10-08T11:55:00.000Z",
                taskChat: true,
              },
            ],
            ARCHIVED_MAIN,
          );
          expect(outcomes).toEqual([{ status: "posted", threadId: "matchday" }]);
          expect(yield* archivedState(ARCHIVED_MAIN)).not.toBeNull();
          expect(renames(dispatched)).toEqual([]);
        }).pipe(Effect.provide(makeLayer(dispatched)));
      },
    );

    it.effect(
      "with no open chat at all, one new chat named like the archived one is made and the archived chat is left alone",
      () => {
        const dispatched: Array<OrchestrationCommand> = [];
        return Effect.gen(function* () {
          const outcomes = yield* run(
            [{ id: ARCHIVED_MAIN, title: "Main", archived: true }],
            ARCHIVED_MAIN,
          );

          expect(outcomes).toHaveLength(1);
          const outcome = outcomes[0]!;
          expect(outcome.status).toBe("posted");
          const created = dispatched.filter((command) => command.type === "thread.create");
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({ title: "Main" });
          const newId = (outcome as { readonly threadId: string }).threadId;
          expect(newId).not.toBe(ARCHIVED_MAIN);
          expect(turnStarts(dispatched).map((turn) => turn.threadId)).toEqual([newId]);
          const sql = yield* SqlClient.SqlClient;
          const [link] = yield* sql<{ readonly botId: string; readonly archivedAt: string | null }>`
            SELECT bot_id AS "botId", archived_at AS "archivedAt"
            FROM personal_bot_threads WHERE thread_id = ${newId}
          `;
          expect(link).toEqual({ botId: "bot-cto", archivedAt: null });
          expect(yield* archivedState(ARCHIVED_MAIN)).not.toBeNull();
          expect(renames(dispatched)).toEqual([]);
        }).pipe(Effect.provide(makeLayer(dispatched)));
      },
    );

    it.effect(
      "a deleted chat is traced to its bot by its task, and the notice goes to the open chat of that name",
      () => {
        const dispatched: Array<OrchestrationCommand> = [];
        return Effect.gen(function* () {
          const outcomes = yield* run(
            [
              { id: "main-deleted", title: "Main", deleted: true },
              { id: "main-open", title: "Main", lastMessageAt: "2026-10-08T10:00:00.000Z" },
            ],
            "main-deleted",
          );
          expect(outcomes).toEqual([{ status: "posted", threadId: "main-open" }]);
        }).pipe(Effect.provide(makeLayer(dispatched)));
      },
    );

    it.effect("a deleted chat nothing ties to a bot is still refused", () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const outcomes = yield* run([], "never-seen");
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected"]);
        expect(dispatched).toEqual([]);
      }).pipe(Effect.provide(makeLayer(dispatched)));
    });

    it.effect("an open chat still gets its notice as before", () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const outcomes = yield* run([{ id: "main-open", title: "Main" }], "main-open");
        expect(outcomes).toEqual([{ status: "posted", threadId: "main-open" }]);
        expect(dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
      }).pipe(Effect.provide(makeLayer(dispatched)));
    });

    it.effect("Harout sending in an archived chat still unarchives it", () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        yield* linkCtoChat;
        yield* seedChats([{ id: ARCHIVED_MAIN, title: "Main", archived: true }]);
        const archive = yield* PersonalTaskChatArchive.PersonalTaskChatArchive;
        // His own message is a turn start in that chat: nothing redirects it, so the
        // turn-start listener unarchives it exactly as before.
        expect(yield* archive.unarchiveForTurn(ThreadId.make(ARCHIVED_MAIN))).toBe(true);
        expect(yield* archivedState(ARCHIVED_MAIN)).toBeNull();
      }).pipe(Effect.provide(makeLayer(dispatched)));
    });

    it.effect("Harout's Unarchive in the app still unarchives and keeps the chat's name", () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        yield* linkCtoChat;
        yield* seedChats([{ id: ARCHIVED_MAIN, title: "Main", archived: true }]);
        const bots = yield* PersonalBotService.PersonalBotService;
        yield* bots.archiveThread({ threadId: ThreadId.make(ARCHIVED_MAIN), archived: false });
        expect(yield* archivedState(ARCHIVED_MAIN)).toBeNull();
        expect(renames(dispatched)).toEqual([]);
      }).pipe(Effect.provide(makeLayer(dispatched)));
    });
  });

  it.effect("an empty or missing inbox is a quiet no-op", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const service = yield* PersonalReleaseNotices;
      expect(yield* service.sweep).toEqual([]);
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });
});
