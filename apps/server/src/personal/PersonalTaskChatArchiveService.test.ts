import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import * as PersonalTaskChatArchive from "./PersonalTaskChatArchiveService.ts";
import { TASK_CHAT_AUTO_ARCHIVE_IDLE_MS } from "./taskChatAutoArchivePolicy.ts";

const MIN = 60_000;
/** When the chats are made (the task starts); everything else is relative. */
const T0 = Date.parse("2026-09-28T18:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const BOT = PersonalBotId.make("bot-backend");

interface LiveShell {
  session: { status: string; activeTurnId: string | null } | null;
  backgroundLiveness: unknown;
  latestTurnCompletedAt: string | null;
}

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly shells: Map<string, LiveShell>;
}

const makeHarness = (): Harness => ({ dispatched: [], shells: new Map() });

/**
 * The real bot service (so the archive is the manual one) and the real
 * repository over an in-memory database; the engine records what it is
 * sent and the projection answers from the harness.
 */
const makeLayer = (harness: Harness) =>
  PersonalTaskChatArchive.layer.pipe(
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            return { sequence: harness.dispatched.length };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() => {
            const shell = harness.shells.get(threadId);
            if (shell === undefined) return Option.none();
            return Option.some({
              id: threadId,
              session: shell.session === null ? null : { threadId, ...shell.session },
              backgroundLiveness: shell.backgroundLiveness,
              latestTurn:
                shell.latestTurnCompletedAt === null
                  ? null
                  : { completedAt: shell.latestTurnCompletedAt },
            });
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-task-archive-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

interface ChatSpec {
  readonly id: string;
  /** Tasks on the chat. Default: one finished delegation. */
  readonly tasks?: ReadonlyArray<{
    readonly source: "delegation" | "routine" | "user";
    readonly status: string;
    readonly endedAtMs?: number;
    readonly parentOf?: string;
  }>;
  readonly sessionStatus?: string;
  readonly pinned?: boolean;
  readonly routine?: boolean;
  readonly groupMember?: boolean;
  /** Messages: [id, role, atMs]. Default: the task brief and the bot's reply. */
  readonly messages?: ReadonlyArray<readonly [string, "user" | "assistant", number]>;
}

const TASK_DONE_MS = T0 + 10 * MIN;

/** One bot and its chats, as the task service leaves them. */
const seed = (harness: Harness, chats: ReadonlyArray<ChatSpec>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const sql = yield* SqlClient.SqlClient;
    const bots = yield* PersonalBotService.PersonalBotService;
    yield* bots.create({
      botId: BOT,
      name: "Backend",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
    });
    for (const chat of chats) {
      const threadId = ThreadId.make(chat.id);
      yield* bots.createThread({ botId: BOT, threadId });
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, pinned_at)
        VALUES (${chat.id}, 'project', ${chat.id}, ${iso(T0)}, ${iso(T0)}, ${chat.pinned === true ? iso(T0) : null})
      `;
      const status = chat.sessionStatus ?? "ready";
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
        VALUES (${chat.id}, ${status}, ${status === "running" ? "turn-live" : null}, ${iso(T0)})
      `;
      harness.shells.set(chat.id, {
        session: { status, activeTurnId: status === "running" ? "turn-live" : null },
        backgroundLiveness: null,
        latestTurnCompletedAt: null,
      });
      const tasks = chat.tasks ?? [{ source: "delegation", status: "completed" }];
      for (const [index, task] of tasks.entries()) {
        const taskId = `${chat.id}-task-${index}`;
        const ended =
          task.status === "running" || task.status === "waiting_for_agent"
            ? null
            : iso(task.endedAtMs ?? TASK_DONE_MS);
        yield* sql`
          INSERT INTO personal_tasks (
            task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective, status,
            source, idempotency_key, depth, max_depth, max_children, created_at, updated_at, completed_at
          )
          VALUES (
            ${taskId}, ${taskId}, NULL, ${BOT}, ${chat.id}, 'Task', 'Do it', ${task.status},
            ${task.source}, ${taskId}, 1, 3, 4, ${iso(T0 - 1_000)}, ${ended ?? iso(T0)}, ${ended}
          )
        `;
        if (task.parentOf !== undefined) {
          // A child task this chat delegated, still open.
          yield* sql`
            INSERT INTO personal_tasks (
              task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective, status,
              source, idempotency_key, depth, max_depth, max_children, created_at, updated_at
            )
            VALUES (
              ${`${taskId}-child`}, ${taskId}, ${taskId}, 'bot-other', ${task.parentOf}, 'Child', 'Do it',
              'running', 'delegation', ${`${taskId}-child`}, 2, 3, 4, ${iso(T0)}, ${iso(T0)}
            )
          `;
        }
      }
      const messages = chat.messages ?? [
        [`personal-task-${chat.id}-1`, "user", T0],
        [`${chat.id}-reply`, "assistant", TASK_DONE_MS],
      ];
      for (const [messageId, role, atMs] of messages) {
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${messageId}, ${chat.id}, ${role}, 'text', 0, ${iso(atMs)}, ${iso(atMs)})
        `;
      }
      if (chat.routine === true) {
        yield* sql`
          INSERT INTO personal_routines (routine_id, bot_id, title, prompt, schedule_json, created_at, updated_at, thread_id)
          VALUES (${`${chat.id}-routine`}, ${BOT}, 'Daily', 'Go', '{}', ${iso(T0)}, ${iso(T0)}, ${chat.id})
        `;
      }
      if (chat.groupMember === true) {
        yield* sql`
          INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
          VALUES ('group-1', 'Crew', 'group-thread', 8, ${iso(T0)}, ${iso(T0)})
        `;
        yield* sql`
          INSERT INTO personal_group_members (group_id, bot_id, thread_id, joined_at)
          VALUES ('group-1', ${BOT}, ${chat.id}, ${iso(T0)})
        `;
      }
    }
  });

const archivedIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId" FROM personal_bot_threads
    WHERE archived_at IS NOT NULL ORDER BY thread_id
  `;
  return rows.map((row) => row.threadId);
});

const sessionStops = (harness: Harness) =>
  harness.dispatched.flatMap((command) =>
    command.type === "thread.session.stop" ? [command] : [],
  );

const sweepAt = (ms: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(ms);
    return yield* (yield* PersonalTaskChatArchive.PersonalTaskChatArchive).sweep;
  });

describe("PersonalTaskChatArchive", () => {
  it.effect(
    "archives a finished task chat after 30 idle minutes, the way a manual archive does",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seed(harness, [{ id: "chat-done" }]);

        expect(yield* sweepAt(TASK_DONE_MS + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS - MIN)).toBe(0);
        expect(yield* archivedIds).toEqual([]);

        expect(yield* sweepAt(TASK_DONE_MS + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS)).toBe(1);
        expect(yield* archivedIds).toEqual(["chat-done"]);
        // Same as a manual archive: the session is stopped and its commands ended.
        expect(sessionStops(harness)).toEqual([
          expect.objectContaining({ threadId: "chat-done", terminateProcesses: true }),
        ]);
        // Nothing is deleted: the link and the task are still there.
        const bots = yield* PersonalBotService.PersonalBotService;
        const list = yield* bots.list();
        expect(list.threads.some((thread) => thread.threadId === "chat-done")).toBe(true);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("waits 30 minutes from Harout's last message or open, not from the task's end", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seed(harness, [
        {
          id: "chat-written",
          messages: [
            ["personal-task-chat-written-1", "user", T0],
            ["reply-1", "assistant", TASK_DONE_MS],
            ["owner-typed-1", "user", TASK_DONE_MS + 35 * MIN],
          ],
        },
        { id: "chat-opened" },
      ]);
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      yield* repository.recordThreadViewed({
        threadId: ThreadId.make("chat-opened"),
        viewedAt: iso(TASK_DONE_MS + 50 * MIN),
      });

      // 41 min after the task ended: both still used recently.
      expect(yield* sweepAt(TASK_DONE_MS + 41 * MIN)).toBe(0);
      // 30 min after Harout wrote: that one goes, the opened one waits.
      expect(yield* sweepAt(TASK_DONE_MS + 65 * MIN)).toBe(1);
      expect(yield* archivedIds).toEqual(["chat-written"]);
      expect(yield* sweepAt(TASK_DONE_MS + 79 * MIN)).toBe(0);
      expect(yield* sweepAt(TASK_DONE_MS + 80 * MIN)).toBe(1);
      expect(yield* archivedIds).toEqual(["chat-opened", "chat-written"]);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "never touches unfinished tasks, routine, group, pinned or user chats, or live sessions",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seed(harness, [
          { id: "chat-running", tasks: [{ source: "delegation", status: "running" }] },
          { id: "chat-waiting", tasks: [{ source: "delegation", status: "waiting_for_agent" }] },
          { id: "chat-routine-task", tasks: [{ source: "routine", status: "completed" }] },
          { id: "chat-routine-home", routine: true },
          { id: "chat-group", groupMember: true },
          { id: "chat-pinned", pinned: true },
          // Harout's own chat: his messages are `user` tasks, and a delegation into it later.
          {
            id: "chat-harout",
            tasks: [
              { source: "user", status: "completed" },
              { source: "delegation", status: "completed" },
            ],
          },
          { id: "chat-no-task", tasks: [] },
          { id: "chat-live-turn", sessionStatus: "running" },
          { id: "chat-background" },
          {
            id: "chat-child-open",
            tasks: [{ source: "delegation", status: "completed", parentOf: "chat-running" }],
          },
          { id: "chat-failed", tasks: [{ source: "delegation", status: "failed" }] },
          { id: "chat-cancelled", tasks: [{ source: "delegation", status: "cancelled" }] },
        ]);
        harness.shells.get("chat-background")!.backgroundLiveness = { liveTaskIds: ["bg-1"] };

        expect(yield* sweepAt(TASK_DONE_MS + 2 * TASK_CHAT_AUTO_ARCHIVE_IDLE_MS)).toBe(2);
        expect(yield* archivedIds).toEqual(["chat-cancelled", "chat-failed"]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("archives nothing while the setting is off", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seed(harness, [{ id: "chat-done" }]);
      const bots = yield* PersonalBotService.PersonalBotService;
      yield* bots.setProfile({ autoArchiveTaskChats: false });
      expect(yield* sweepAt(TASK_DONE_MS + 2 * TASK_CHAT_AUTO_ARCHIVE_IDLE_MS)).toBe(0);
      expect(yield* archivedIds).toEqual([]);

      yield* bots.setProfile({ autoArchiveTaskChats: true });
      expect(yield* sweepAt(TASK_DONE_MS + 2 * TASK_CHAT_AUTO_ARCHIVE_IDLE_MS)).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("survives a restart, archives once, and leaves an unarchived chat alone", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seed(harness, [{ id: "chat-done" }]);
      const due = TASK_DONE_MS + TASK_CHAT_AUTO_ARCHIVE_IDLE_MS;

      // First server: archives it.
      expect(yield* sweepAt(due)).toBe(1);
      // A restart: a fresh service on the same database sweeps at startup.
      const restarted = yield* PersonalTaskChatArchive.make;
      expect(yield* restarted.sweep).toBe(0);
      expect(yield* restarted.sweep).toBe(0);
      expect(sessionStops(harness)).toHaveLength(1);

      // Harout unarchives it: it stays open however long it sits.
      const bots = yield* PersonalBotService.PersonalBotService;
      yield* bots.archiveThread({ threadId: ThreadId.make("chat-done"), archived: false });
      yield* TestClock.setTime(due + 24 * 60 * MIN);
      expect(yield* restarted.sweep).toBe(0);
      expect(yield* archivedIds).toEqual([]);
    }).pipe(Effect.provide(makeLayer(harness)));
  });
});
