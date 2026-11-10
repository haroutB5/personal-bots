// @effect-diagnostics nodeBuiltinImport:off - writes notice files into the test server's inbox like notify-release.ps1 does.
// @effect-diagnostics preferSchemaOverJson:off - writes the notice JSON verbatim, as the script does.
// @effect-diagnostics globalDateInEffect:off - fixture exercises wall-clock file freshness and throttling.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import { PersonalProviders } from "../engine/PersonalProviders.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskChatArchive from "../PersonalTaskChatArchiveService.ts";
import { withSchedulersEnv } from "../schedulersSwitch.testFixtures.ts";
import {
  makePersonalEngineHarness,
  personalEngineTestLayer,
  type PersonalEngineHarness,
} from "../test/personalEngineTestLayer.ts";
import { personalTestDatabase } from "../test/personalReadsTestLayer.ts";
import { seedV2Message, seedV2Thread } from "../test/v2ProjectionSeed.ts";
import {
  PersonalReleaseNotices,
  RELEASE_NOTICE_DIR,
  layer as releaseNoticeLayer,
} from "./PersonalReleaseNoticeService.ts";

const CTO_CHAT = "thread-cto-chat";
const PLAIN_THREAD = "thread-not-a-bot";
const CHAT_CREATED = "2026-10-08T09:00:00.000Z";

const makeLayer = (harness: PersonalEngineHarness) =>
  releaseNoticeLayer.pipe(
    Layer.provideMerge(PersonalTaskChatArchive.layer),
    Layer.provideMerge(PersonalBotService.layerRequiringEngine),
    Layer.provideMerge(
      Layer.mock(PersonalProviders)({
        listProviders: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-release-notice-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(personalEngineTestLayer(harness)),
    Layer.provideMerge(personalTestDatabase),
  );

const seedThread = (input: {
  readonly id: string;
  readonly title: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}) =>
  seedV2Thread({
    threadId: input.id,
    title: input.title,
    instanceId: "claudeAgent",
    model: "claude-sonnet-5-5",
    createdAt: CHAT_CREATED,
    archivedAt: input.archivedAt ?? null,
    deletedAt: input.deletedAt ?? null,
  });

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
  yield* seedThread({ id: CTO_CHAT, title: "Release hub" });
  yield* seedThread({ id: PLAIN_THREAD, title: "Main" });
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

const messageDispatches = (harness: PersonalEngineHarness) =>
  harness.dispatched.filter(
    (command): command is Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> =>
      command.type === "message.dispatch",
  );

describe("PersonalReleaseNotices", () => {
  it.effect("the next server consumes a live runner waiting alert exactly once", () => {
    const harness = makePersonalEngineHarness();
    return Effect.gen(function* () {
      yield* linkCtoChat;
      const config = yield* ServerConfig.ServerConfig;
      const runDir = NodePath.join(config.baseDir, "run");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(runDir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(runDir, "restart-9.9.9-result.json"),
          JSON.stringify({
            runner: "hbots-release.mjs (linux)",
            mode: "run",
            status: "waiting_for_idle",
            version: "9.9.9",
            release: "abc123def456",
            runnerPid: 123,
            updatedAt: new Date().toISOString(),
            notifyThread: CTO_CHAT,
            waitingAlert: {
              minutes: 20,
              text: "hbots release 9.9.9 waiting on: node pid 123, 245s",
              at: "2026-10-26T20:00:00Z",
            },
          }),
        );
      });
      const service = yield* PersonalReleaseNotices;
      expect(yield* service.sweep).toEqual([{ status: "posted", threadId: CTO_CHAT }]);
      expect(yield* service.sweep).toEqual([]);
      const turns = messageDispatches(harness);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.text).toContain("waiting on: node pid 123, 245s");
      expect(turns[0]!.text).not.toContain("re-arm");
      yield* Effect.promise(async () => {
        const file = NodePath.join(runDir, "restart-9.9.9-result.json");
        const result = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        result.waitingAlert = { ...result.waitingAlert, minutes: 60, at: "2026-10-26T20:40:00Z" };
        await NodeFSP.writeFile(file, JSON.stringify(result));
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
      expect(yield* service.sweep).toEqual([{ status: "posted", threadId: CTO_CHAT }]);
      expect(yield* service.sweep).toEqual([]);
      expect(messageDispatches(harness)).toHaveLength(2);
      clock.mockRestore();
    }).pipe(Effect.provide(makeLayer(harness)));
  });
  it.effect("a runner that delivered its own waiting notice is not queued again", () => {
    const harness = makePersonalEngineHarness();
    return Effect.gen(function* () {
      yield* linkCtoChat;
      const config = yield* ServerConfig.ServerConfig;
      const runDir = NodePath.join(config.baseDir, "run");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(runDir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(runDir, "restart-9.9.9-result.json"),
          JSON.stringify({
            runner: "hbots-release.mjs (linux)",
            mode: "run",
            status: "waiting_for_idle",
            version: "9.9.9",
            release: "abc123def456",
            runnerPid: 123,
            updatedAt: new Date().toISOString(),
            notifyThread: CTO_CHAT,
            waitingAlert: {
              minutes: 20,
              text: "hbots release 9.9.9 waiting on: node pid 123, 245s",
              at: "2026-10-26T20:00:00Z",
              noticeFile:
                "/home/harout/.personal-bots/dev/personal/release-notices/1-9.9.9-waiting-123-20.json",
            },
          }),
        );
      });
      const service = yield* PersonalReleaseNotices;
      expect(yield* service.sweep).toEqual([]);
      expect(messageDispatches(harness)).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });
  it.effect("a waiting notice posts once without saying the release failed", () => {
    const harness = makePersonalEngineHarness();
    return Effect.gen(function* () {
      yield* linkCtoChat;
      yield* writeNotice("waiting.json", {
        threadId: CTO_CHAT,
        version: "1.66.97",
        release: "abc123def456",
        outcome: "waiting",
        detail: "node pid 123, 40m",
      });
      const service = yield* PersonalReleaseNotices;
      expect(yield* service.sweep).toEqual([{ status: "posted", threadId: CTO_CHAT }]);
      expect(yield* service.sweep).toEqual([]);
      const turns = messageDispatches(harness);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.text).toContain("still waiting for idle");
      expect(turns[0]!.text).toContain("node pid 123, 40m");
      expect(turns[0]!.text).not.toContain("re-arm");
    }).pipe(Effect.provide(makeLayer(harness)));
  });
  it.effect("a successful release posts exactly one turn into the requesting chat", () => {
    const harness = makePersonalEngineHarness();
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
      const turns = messageDispatches(harness);
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      expect(turn.threadId).toBe(CTO_CHAT);
      expect(turn.messageId).toBe("personal-notice-release-20261001T230000Z-live");
      expect(turn.text).toContain(
        "Release landed: hbots 1.60.18 (release abc123def456) is live. Smoke exit 0. No rollback.",
      );
      expect(turn.text).toContain("restart-1.60.18.log");
      expect(turn.text).toContain("Confirm the live release. No QA recheck is needed.");
      expect(turn.context?.records[0]).toMatchObject({
        kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
        payload: { notice: "release-landed" },
      });
      // The chat's own modes: a changed runtime mode would restart its session.
      // The v2 dispatch carries no modes of its own, so read them from the
      // thread the notice went to.
      const sql = yield* SqlClient.SqlClient;
      const [modes] = yield* sql<{
        readonly runtimeMode: string;
        readonly interactionMode: string;
      }>`
        SELECT runtime_mode AS "runtimeMode", interaction_mode AS "interactionMode"
        FROM orchestration_v2_projection_threads WHERE thread_id = ${CTO_CHAT}
      `;
      expect(modes).toEqual({ runtimeMode: "full-access", interactionMode: "default" });
      const dir = yield* inboxDir;
      const posted = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "posted")));
      expect(posted).toEqual(["20261001T230000Z-live.json"]);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("a rollback posts exactly one turn with the rollback status", () => {
    const harness = makePersonalEngineHarness();
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

      const turns = messageDispatches(harness);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.text).toContain(
        "failed its smoke (exit 1) and was rolled back to 5531a1f12aeb: rollback exit 0, rollback smoke exit 0.",
      );
      expect(turns[0]!.text).toContain("Detail: FAIL  /version.txt mismatch");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("no thread id, a plain thread or a broken file posts nothing", () => {
    const harness = makePersonalEngineHarness();
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
      expect(harness.dispatched).toEqual([]);
      const dir = yield* inboxDir;
      const rejected = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dir, "rejected")));
      expect(rejected).toHaveLength(5);
      expect(yield* service.sweep).toEqual([]);
    }).pipe(Effect.provide(makeLayer(harness)));
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
        const sql = yield* SqlClient.SqlClient;
        const created = CHAT_CREATED;
        for (const chat of chats) {
          if (chat.deleted !== true) {
            yield* sql`
              INSERT INTO personal_bot_threads (thread_id, bot_id, created_at, archived_at)
              VALUES (${chat.id}, 'bot-cto', ${created}, ${chat.archived === true ? "2026-10-08T10:00:00.000Z" : null})
            `;
          }
          yield* seedThread({
            id: chat.id,
            title: chat.title,
            deletedAt: chat.deleted === true ? created : null,
          });
          if (chat.lastMessageAt !== undefined) {
            yield* seedV2Message({
              messageId: `${chat.id}-m`,
              threadId: chat.id,
              text: "hi",
              createdAt: chat.lastMessageAt,
            });
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

    const threadTitle = (id: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ readonly title: string }>`
          SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ${id}
        `;
        return row?.title ?? null;
      });

    const run = (chats: ReadonlyArray<ChatSeed>, target: string, ctoChatOpen = true) =>
      Effect.gen(function* () {
        yield* linkCtoChat;
        if (!ctoChatOpen) {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE personal_bot_threads SET archived_at = '2026-10-01T00:00:00.000Z'
            WHERE thread_id = ${CTO_CHAT}
          `;
        }
        yield* seedChats(chats);
        yield* writeNotice("20261008T120000Z-live.json", { ...BASE, threadId: target });
        const service = yield* PersonalReleaseNotices;
        return yield* service.sweep;
      });

    /** The rename a notice must never cause. */
    const renames = (harness: PersonalEngineHarness) =>
      harness.dispatched.filter((command) => command.type === "thread.metadata.update");

    it.effect(
      "goes to the bot's open chat with the same name; the archived chat stays archived and keeps its name",
      () => {
        const harness = makePersonalEngineHarness();
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
          expect(messageDispatches(harness).map((turn) => turn.threadId)).toEqual([
            "thread-main-new",
          ]);
          expect(messageDispatches(harness)[0]!.text).toContain("Release landed");
          // Still archived, still called "Main", nothing renamed or unarchived.
          expect(yield* archivedState(ARCHIVED_MAIN)).not.toBeNull();
          expect(yield* threadTitle(ARCHIVED_MAIN)).toBe("Main");
          expect(renames(harness)).toEqual([]);
          expect(harness.dispatched.map((command) => command.type)).toEqual(["message.dispatch"]);
        }).pipe(Effect.provide(makeLayer(harness)));
      },
    );

    it.effect("with several open chats of that name, the most recently active one takes it", () => {
      const harness = makePersonalEngineHarness();
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
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect(
      "with no open chat of that name, the bot's most recently active conversation takes it, not a task chat",
      () => {
        const harness = makePersonalEngineHarness();
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
          expect(renames(harness)).toEqual([]);
        }).pipe(Effect.provide(makeLayer(harness)));
      },
    );

    it.effect(
      "with no open chat at all, one new chat named like the archived one is made and the archived chat is left alone",
      () => {
        const harness = makePersonalEngineHarness();
        return Effect.gen(function* () {
          const outcomes = yield* run(
            [{ id: ARCHIVED_MAIN, title: "Main", archived: true }],
            ARCHIVED_MAIN,
            false,
          );

          expect(outcomes).toHaveLength(1);
          const outcome = outcomes[0]!;
          expect(outcome.status).toBe("posted");
          const created = harness.dispatched.filter((command) => command.type === "thread.create");
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({ title: "Main" });
          const newId = (outcome as { readonly threadId: string }).threadId;
          expect(newId).not.toBe(ARCHIVED_MAIN);
          expect(messageDispatches(harness).map((turn) => turn.threadId)).toEqual([newId]);
          const sql = yield* SqlClient.SqlClient;
          const [link] = yield* sql<{ readonly botId: string; readonly archivedAt: string | null }>`
            SELECT bot_id AS "botId", archived_at AS "archivedAt"
            FROM personal_bot_threads WHERE thread_id = ${newId}
          `;
          expect(link).toEqual({ botId: "bot-cto", archivedAt: null });
          expect(yield* archivedState(ARCHIVED_MAIN)).not.toBeNull();
          expect(renames(harness)).toEqual([]);
        }).pipe(Effect.provide(makeLayer(harness)));
      },
    );

    it.effect(
      "a deleted chat is traced to its bot by its task, and the notice goes to the open chat of that name",
      () => {
        const harness = makePersonalEngineHarness();
        return Effect.gen(function* () {
          const outcomes = yield* run(
            [
              { id: "main-deleted", title: "Main", deleted: true },
              { id: "main-open", title: "Main", lastMessageAt: "2026-10-08T10:00:00.000Z" },
            ],
            "main-deleted",
          );
          expect(outcomes).toEqual([{ status: "posted", threadId: "main-open" }]);
        }).pipe(Effect.provide(makeLayer(harness)));
      },
    );

    it.effect("a deleted chat nothing ties to a bot is still refused", () => {
      const harness = makePersonalEngineHarness();
      return Effect.gen(function* () {
        const outcomes = yield* run([], "never-seen");
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected"]);
        expect(harness.dispatched).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("an open chat still gets its notice as before", () => {
      const harness = makePersonalEngineHarness();
      return Effect.gen(function* () {
        const outcomes = yield* run([{ id: "main-open", title: "Main" }], "main-open");
        expect(outcomes).toEqual([{ status: "posted", threadId: "main-open" }]);
        expect(harness.dispatched.map((command) => command.type)).toEqual(["message.dispatch"]);
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("Harout sending in an archived chat still unarchives it", () => {
      const harness = makePersonalEngineHarness();
      return Effect.gen(function* () {
        yield* linkCtoChat;
        yield* seedChats([{ id: ARCHIVED_MAIN, title: "Main", archived: true }]);
        const archive = yield* PersonalTaskChatArchive.PersonalTaskChatArchive;
        // His own message is a turn start in that chat: nothing redirects it, so the
        // turn-start listener unarchives it exactly as before.
        expect(yield* archive.unarchiveForTurn(ThreadId.make(ARCHIVED_MAIN))).toBe(true);
        expect(yield* archivedState(ARCHIVED_MAIN)).toBeNull();
      }).pipe(Effect.provide(makeLayer(harness)));
    });

    it.effect("Harout's Unarchive in the app still unarchives and keeps the chat's name", () => {
      const harness = makePersonalEngineHarness();
      return Effect.gen(function* () {
        yield* linkCtoChat;
        yield* seedChats([{ id: ARCHIVED_MAIN, title: "Main", archived: true }]);
        const bots = yield* PersonalBotService.PersonalBotService;
        yield* bots.archiveThread({ threadId: ThreadId.make(ARCHIVED_MAIN), archived: false });
        expect(yield* archivedState(ARCHIVED_MAIN)).toBeNull();
        expect(renames(harness)).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    });
  });

  it.effect("an empty or missing inbox is a quiet no-op", () => {
    const harness = makePersonalEngineHarness();
    return Effect.gen(function* () {
      const service = yield* PersonalReleaseNotices;
      expect(yield* service.sweep).toEqual([]);
      expect(harness.dispatched).toEqual([]);
    }).pipe(Effect.provide(makeLayer(harness)));
  });
});

describe("PersonalReleaseNotices with T3CODE_PERSONAL_SCHEDULERS (restored test copies)", () => {
  const NOTICE = "20261015T090000Z-live.json";
  /** A restored copy whose inbox still holds a notice for the CTO chat. */
  const sweepPendingNotice = () => {
    const harness = makePersonalEngineHarness();
    return Effect.gen(function* () {
      yield* linkCtoChat;
      yield* writeNotice(NOTICE, {
        threadId: CTO_CHAT,
        version: "1.66.48",
        release: "abc123def456",
        outcome: "live",
        smokeExit: 0,
        logPath: "C:\Users\Ht\.personal-bots\logs\restart-1.66.48.log",
      });
      const service = yield* PersonalReleaseNotices;
      const outcomes = yield* service.sweep;
      const dir = yield* inboxDir;
      const inbox = yield* Effect.promise(async () =>
        (await NodeFSP.readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name),
      );
      return { outcomes, inbox, turns: messageDispatches(harness) };
    }).pipe(Effect.provide(makeLayer(harness)));
  };

  it.effect("off: a pending notice is not posted and stays in the inbox", () =>
    Effect.gen(function* () {
      const { outcomes, inbox, turns } = yield* sweepPendingNotice();
      expect(outcomes).toEqual([]);
      expect(turns).toEqual([]);
      expect(inbox).toEqual([NOTICE]);
    }).pipe(withSchedulersEnv("off")),
  );

  it.effect("on: the same notice posts one turn, as before", () =>
    Effect.gen(function* () {
      const { outcomes, inbox, turns } = yield* sweepPendingNotice();
      expect(outcomes).toEqual([{ status: "posted", threadId: CTO_CHAT }]);
      expect(turns).toHaveLength(1);
      expect(inbox).toEqual([]);
    }).pipe(withSchedulersEnv("on")),
  );
});
