// @effect-diagnostics preferSchemaOverJson:off - builds provider activity rows
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  OrchestrationMessageContext,
  PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
  PersonalBotId,
  PersonalTaskId,
  PersonalTaskResult,
  ProviderInstanceId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type PersonalTask,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalModelFallback from "../PersonalModelFallbackService.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  threadExposureKey,
} from "../browser/sensitiveExposureStore.ts";
import * as PersonalTaskService from "./PersonalTaskService.ts";
import { TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL } from "../taskChatAutoArchivePolicy.ts";

/**
 * Stand-ins for the orchestration side: commands are recorded, and the
 * projected session/messages the dispatcher reads are set by each test
 * before it feeds the matching domain event. No timers: every wait is a
 * dispatcher drain.
 */
interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly sessions: Map<string, OrchestrationSession>;
  readonly messages: Map<string, Array<ProjectionThreadMessage>>;
  /** Titles the projection reports for chats (a chat without one has no title key). */
  readonly titles: Map<string, string>;
  sequence: number;
}

const optionOf = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value);

const compareNewestFirst = (
  left: { readonly createdAt: string; readonly messageId: string },
  right: { readonly createdAt: string; readonly messageId: string },
) => right.createdAt.localeCompare(left.createdAt) || right.messageId.localeCompare(left.messageId);

const makeHarness = (): Harness => ({
  dispatched: [],
  sessions: new Map(),
  messages: new Map(),
  titles: new Map(),
  sequence: 0,
});

/** `dbPath` rebuilds the service over a file database, simulating a restart. */
const makeLayer = (
  harness: Harness,
  dbPath?: string,
  /** Wraps the bot repository the task service (and the test) sees, to stage a race. */
  decorateBots?: (
    bots: PersonalBotRepository.PersonalBotRepository["Service"],
  ) => PersonalBotRepository.PersonalBotRepository["Service"],
  /** Turns the usage-limit model fallback on, with these provider snapshots. */
  fallbackProviders?: ReadonlyArray<unknown>,
) =>
  PersonalTaskService.layer.pipe(
    Layer.provideMerge(fallbackProviders === undefined ? Layer.empty : PersonalModelFallback.layer),
    Layer.provideMerge(
      decorateBots === undefined
        ? Layer.empty
        : Layer.effect(
            PersonalBotRepository.PersonalBotRepository,
            Effect.gen(function* () {
              return decorateBots(yield* PersonalBotRepository.PersonalBotRepository);
            }),
          ),
    ),
    Layer.provideMerge(PersonalTaskRepository.layer),
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(
      dbPath === undefined ? SqlitePersistenceMemory : makeSqlitePersistenceLive(dbPath),
    ),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            return { sequence: harness.dispatched.length };
          }),
        subscribeDomainEvents: Effect.succeed(Stream.never),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed(fallbackProviders ?? []),
        refreshInstance: () => Effect.succeed(fallbackProviders ?? []),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() => {
            const session = harness.sessions.get(threadId);
            const title = harness.titles.get(threadId);
            return session === undefined
              ? Option.none()
              : Option.some({
                  id: threadId,
                  session,
                  ...(title === undefined ? {} : { title, archivedAt: null }),
                });
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
          Effect.sync(() => harness.messages.get(threadId) ?? []),
        getByMessageId: ({ messageId }: { readonly messageId: MessageId }) =>
          Effect.sync(() => {
            for (const list of harness.messages.values()) {
              const found = list.find((message) => message.messageId === messageId);
              if (found !== undefined) return Option.some(found);
            }
            return Option.none();
          }),
        // Same order as the SQL: newest by (created_at, message_id), one row.
        getLatestAssistantMessageForTurn: ({
          threadId,
          turnId,
        }: {
          readonly threadId: ThreadId;
          readonly turnId: TurnId;
        }) =>
          Effect.sync(() =>
            optionOf(
              (harness.messages.get(threadId) ?? [])
                .filter((message) => message.role === "assistant" && message.turnId === turnId)
                .toSorted(compareNewestFirst)[0],
            ),
          ),
        getLatestAssistantMessageAfter: ({
          threadId,
          afterCreatedAt,
          afterMessageId,
        }: {
          readonly threadId: ThreadId;
          readonly afterCreatedAt: string;
          readonly afterMessageId: MessageId;
        }) =>
          Effect.sync(() => {
            // The harness appends in thread order under a frozen TestClock, so
            // "after the anchor" is positional here, as the real ORDER BY
            // (created_at, message_id) makes it in the database.
            const list = harness.messages.get(threadId) ?? [];
            const anchor = list.findIndex((message) => message.messageId === afterMessageId);
            void afterCreatedAt;
            return optionOf(
              list.slice(anchor + 1).findLast((message) => message.role === "assistant"),
            );
          }),
      } as unknown as ProjectionThreadMessageRepositoryShape),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-tasks-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const BOTS = ["assistant", "developer", "researcher", "planner"] as const;
type BotKey = (typeof BOTS)[number];
const botId = (key: BotKey) => PersonalBotId.make(`bot-${key}`);

const seedBots = Effect.gen(function* () {
  const bots = yield* PersonalBotService.PersonalBotService;
  for (const key of BOTS) {
    yield* bots.create({
      botId: botId(key),
      name: key[0]!.toUpperCase() + key.slice(1),
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
    });
  }
});

const turnStarts = (harness: Harness) =>
  harness.dispatched.flatMap((command) => (command.type === "thread.turn.start" ? [command] : []));

const interrupts = (harness: Harness) =>
  harness.dispatched.flatMap((command) =>
    command.type === "thread.turn.interrupt" ? [command] : [],
  );

const makeSession = (input: {
  readonly threadId: ThreadId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId: TurnId | null;
  readonly lastError?: string;
  readonly providerRetry?: OrchestrationSession["providerRetry"];
  readonly providerInstanceId?: string;
  readonly updatedAt: string;
}): OrchestrationSession => ({
  threadId: input.threadId,
  status: input.status,
  providerName: "codex",
  ...(input.providerInstanceId !== undefined
    ? { providerInstanceId: ProviderInstanceId.make(input.providerInstanceId) }
    : {}),
  runtimeMode: "full-access",
  activeTurnId: input.activeTurnId,
  lastError: input.lastError ?? null,
  ...(input.providerRetry !== undefined ? { providerRetry: input.providerRetry } : {}),
  updatedAt: input.updatedAt,
});

const sessionEvent = (harness: Harness, session: OrchestrationSession): OrchestrationEvent => {
  harness.sequence += 1;
  const id = `evt-${harness.sequence}`;
  return {
    sequence: harness.sequence,
    eventId: EventId.make(id),
    aggregateKind: "thread",
    aggregateId: session.threadId,
    type: "thread.session-set",
    occurredAt: session.updatedAt,
    commandId: CommandId.make(`cmd-${id}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${id}`),
    metadata: {},
    payload: { threadId: session.threadId, session },
  } as OrchestrationEvent;
};

const setSession = (
  harness: Harness,
  session: OrchestrationSession,
): Effect.Effect<void, never, PersonalTaskService.PersonalTaskService> =>
  Effect.gen(function* () {
    const service = yield* PersonalTaskService.PersonalTaskService;
    harness.sessions.set(session.threadId, session);
    yield* service.ingestDomainEvent(sessionEvent(harness, session));
    yield* service.drain;
  });

/** Marks the thread's turn as started (running with a turn id). */
const beginTurn = (harness: Harness, threadId: ThreadId) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const turnId = TurnId.make(`turn-${threadId}-${harness.sequence + 1}`);
    yield* setSession(
      harness,
      makeSession({ threadId, status: "running", activeTurnId: turnId, updatedAt: now }),
    );
    return turnId;
  });

/** Ends the thread's running turn: writes the reply, then the terminal session. */
const endTurn = (
  harness: Harness,
  threadId: ThreadId,
  turnId: TurnId,
  reply: string,
  end: {
    readonly status?: OrchestrationSession["status"];
    readonly lastError?: string;
    readonly providerRetry?: OrchestrationSession["providerRetry"];
  } = {},
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    harness.messages.set(threadId, [
      ...(harness.messages.get(threadId) ?? []),
      {
        messageId: MessageId.make(`msg-${turnId}`),
        threadId,
        turnId,
        role: "assistant",
        text: reply,
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    yield* setSession(
      harness,
      makeSession({
        threadId,
        status: end.status ?? "ready",
        activeTurnId: null,
        ...(end.lastError === undefined ? {} : { lastError: end.lastError }),
        ...(end.providerRetry === undefined ? {} : { providerRetry: end.providerRetry }),
        updatedAt: now,
      }),
    );
  });

const runTurn = (
  harness: Harness,
  threadId: ThreadId,
  reply: string,
  end: {
    readonly status?: OrchestrationSession["status"];
    readonly lastError?: string;
    readonly providerRetry?: OrchestrationSession["providerRetry"];
  } = {},
) =>
  Effect.gen(function* () {
    const turnId = yield* beginTurn(harness, threadId);
    yield* endTurn(harness, threadId, turnId, reply, end);
  });

const reload = (taskId: PersonalTask["taskId"]) =>
  Effect.gen(function* () {
    const service = yield* PersonalTaskService.PersonalTaskService;
    return (yield* service.get({ taskId })).task;
  });

const threadOf = (task: PersonalTask) => {
  if (task.threadId === null) {
    throw new Error(`task ${task.taskId} has no thread yet`);
  }
  return task.threadId;
};

const createRoot = (key: string, bot: BotKey = "assistant") =>
  Effect.gen(function* () {
    const service = yield* PersonalTaskService.PersonalTaskService;
    const task = yield* service.createTask({
      idempotencyKey: key,
      botId: botId(bot),
      title: `Root ${key}`,
      objective: `Do the ${key} thing.`,
    });
    yield* service.drain;
    return yield* reload(task.taskId);
  });

const brief = (title: string) => ({ title, objective: `${title} objective` });

it.effect("createTask is idempotent on its key and starts exactly one turn", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const input = {
      idempotencyKey: "client-key-1",
      botId: botId("assistant"),
      title: "Plan the week",
      objective: "Draft a weekly plan.",
    };
    const first = yield* service.createTask(input);
    const second = yield* service.createTask(input);
    yield* service.drain;
    const third = yield* service.createTask(input);

    expect(second.taskId).toBe(first.taskId);
    expect(third.taskId).toBe(first.taskId);
    expect((yield* service.list({})).tasks.map((task) => task.taskId)).toEqual([first.taskId]);

    const starts = turnStarts(harness);
    expect(starts.length).toBe(1);
    expect(starts[0]!.message.text.startsWith("[Task from you]")).toBe(true);
    expect(starts[0]!.message.text).toContain("Draft a weekly plan.");
    const running = yield* reload(first.taskId);
    expect(running.status).toBe("running");
    expect(starts[0]!.threadId).toBe(running.threadId);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("relay posts the text as the bot's message in a new chat, completed, once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const input = {
      idempotencyKey: "routine:weekly:event:2026-09-20T09:00:00.000Z",
      botId: botId("assistant"),
      title: "Weekly upstream sync report",
      text: "Synced 12 commits. Gates green.",
      source: "routine" as const,
    };
    const first = yield* service.relay(input);
    const again = yield* service.relay(input);
    yield* service.drain;

    expect(again.taskId).toBe(first.taskId);
    expect(first).toMatchObject({
      status: "completed",
      source: "routine",
      result: { summary: input.text },
    });
    expect(first.threadId).not.toBeNull();
    expect(turnStarts(harness)).toEqual([]);
    // The first chat of the bot also creates the personal project.
    const types = harness.dispatched
      .map((command) => command.type)
      .filter((type) => type !== "project.create");
    expect(types).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.message.assistant.delta",
      "thread.message.assistant.complete",
    ]);
    const delta = harness.dispatched.find(
      (command) => command.type === "thread.message.assistant.delta",
    );
    expect(delta).toMatchObject({ threadId: first.threadId, delta: input.text });
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const link = yield* bots.getThreadLink({ threadId: first.threadId! });
    expect(Option.map(link, (entry) => entry.botId)).toEqual(Option.some(botId("assistant")));
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("depth and child limits are persisted on the root and survive a restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-tasks-db-" });
    const dbPath = path.join(directory, "state.sqlite");
    const { rootId, childId } = yield* Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* service.createTask({
        idempotencyKey: "limits-root",
        botId: botId("assistant"),
        title: "Root",
        objective: "Root objective",
        maxDepth: 1,
        maxChildren: 1,
      });
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Child"),
      });
      yield* service.drain;
      return { rootId: root.taskId, childId: child.taskId };
    }).pipe(Effect.provide(makeLayer(makeHarness(), dbPath)));

    // A fresh service over the same database: the limits come from the root row.
    yield* Effect.gen(function* () {
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* reload(rootId);
      expect([root.maxDepth, root.maxChildren]).toEqual([1, 1]);

      const tooMany = yield* Effect.flip(
        service.delegate({
          parentTaskId: rootId,
          targetBotId: botId("researcher"),
          brief: brief("Second child"),
        }),
      );
      expect(tooMany.message).toContain("at most 1 delegated tasks");

      const tooDeep = yield* Effect.flip(
        service.delegate({
          parentTaskId: childId,
          targetBotId: botId("planner"),
          brief: brief("Grandchild"),
        }),
      );
      expect(tooDeep.message).toContain("depth limit");
      expect((yield* service.list({ rootTaskId: rootId })).tasks.length).toBe(2);
    }).pipe(Effect.provide(makeLayer(makeHarness(), dbPath)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "delegation rejects ancestry loops but lets a child hand work back to the root bot",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("ancestry");
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Implement"),
      });

      const selfLoop = yield* Effect.flip(
        service.delegate({
          parentTaskId: child.taskId,
          targetBotId: botId("developer"),
          brief: brief("Implement again"),
        }),
      );
      expect(selfLoop.message).toContain("Delegation loop");

      const rootLoop = yield* Effect.flip(
        service.delegate({
          parentTaskId: root.taskId,
          targetBotId: botId("assistant"),
          brief: brief("Ask myself"),
        }),
      );
      expect(rootLoop.message).toContain("Delegation loop");

      const handBack = yield* service.delegate({
        parentTaskId: child.taskId,
        targetBotId: botId("assistant"),
        brief: brief("Review for the root"),
      });
      expect(handBack.depth).toBe(2);
      expect(handBack.parentTaskId).toBe(child.taskId);
      expect(handBack.rootTaskId).toBe(root.taskId);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("a waiting parent releases its slot so both children run when slots are full", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    // Other running roots take every slot but the two the root and its first child need.
    const fillers = PersonalTaskService.PERSONAL_TASKS_CONCURRENCY - 2;
    for (let slot = 1; slot <= fillers; slot++) {
      yield* createRoot(`slots-filler-${slot}`, "planner");
    }
    const root = yield* createRoot("slots");
    const rootThread = threadOf(root);
    const rootTurn = yield* beginTurn(harness, rootThread);
    const first = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("developer"),
      brief: brief("Build it"),
    });
    const second = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("researcher"),
      brief: brief("Research it"),
    });
    yield* service.drain;

    // Root's turn is still running: it and the first child fill the last two slots.
    expect((yield* reload(first.taskId)).status).toBe("running");
    expect((yield* reload(second.taskId)).status).toBe("queued");
    expect(turnStarts(harness).length).toBe(fillers + 2);

    // Root's turn ends while children are open: it waits and frees its slot.
    yield* endTurn(harness, rootThread, rootTurn, "Delegated.");
    const waitingRoot = yield* reload(root.taskId);
    expect(waitingRoot.status).toBe("waiting_for_agent");
    const firstRunning = yield* reload(first.taskId);
    const secondRunning = yield* reload(second.taskId);
    expect([firstRunning.status, secondRunning.status]).toEqual(["running", "running"]);
    expect(turnStarts(harness).length).toBe(fillers + 3);
    expect(turnStarts(harness)[fillers + 2]!.message.text).toContain(
      "[Delegated task from Assistant]",
    );

    // The first result is delivered at once, with the second still running.
    yield* runTurn(harness, threadOf(firstRunning), "Built.");
    expect((yield* reload(first.taskId)).status).toBe("completed");
    expect((yield* reload(root.taskId)).status).toBe("running");
    const firstContinuation = turnStarts(harness).at(-1)!;
    expect(firstContinuation.threadId).toBe(rootThread);
    expect(firstContinuation.message.text).toContain("Built.");
    expect(firstContinuation.message.text).not.toContain("Researched.");
    yield* runTurn(harness, rootThread, "Waiting for the research.");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");

    yield* runTurn(harness, threadOf(secondRunning), "Researched.");
    const continued = yield* reload(root.taskId);
    expect(continued.status).toBe("running");
    const continuation = turnStarts(harness).at(-1)!;
    expect(continuation.threadId).toBe(rootThread);
    expect(continuation.message.text).toContain("[Task continuation]");
    expect(continuation.message.text).toContain("Researched.");
    expect(continuation.message.text).not.toContain("Built.");

    yield* runTurn(harness, rootThread, "All done.");
    const done = yield* reload(root.taskId);
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ summary: "All done." });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("browser help parks a task and resumes it with a server-authored continuation", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("browser-help");
    const rootThread = threadOf(root);
    const firstTurn = yield* beginTurn(harness, rootThread);

    const waiting = yield* service.waitForBrowser({ taskId: root.taskId });
    expect(waiting.status).toBe("waiting_for_browser");
    yield* endTurn(harness, rootThread, firstTurn, "I need browser help.");

    yield* service.resumeFromUser({
      taskId: root.taskId,
      noteId: "browser-help:1",
      note: "The user finished helping in the browser. Continue the task.",
      restartSession: false,
    });
    yield* service.drain;

    expect((yield* reload(root.taskId)).status).toBe("running");
    const continuation = turnStarts(harness).at(-1)!;
    expect(continuation.threadId).toBe(rootThread);
    expect(continuation.message.text).toContain("[Task continuation]");
    expect(continuation.message.text).toContain(
      "The user finished helping in the browser. Continue the task.",
    );
    expect(continuation.message.context?.records[0]).toMatchObject({
      kind: "personal-task",
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a child's completion re-queues its parent exactly once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("requeue");
    const rootThread = threadOf(root);
    const turnId = yield* beginTurn(harness, rootThread);
    const child = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("developer"),
      brief: brief("Fix it"),
    });
    yield* endTurn(harness, rootThread, turnId, "Waiting on Developer.");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");

    const childThread = threadOf(yield* reload(child.taskId));
    yield* runTurn(harness, childThread, "Fixed.");
    // Replays of the child's terminal session and a full sweep change nothing.
    const replay = harness.sessions.get(childThread)!;
    yield* service.ingestDomainEvent(sessionEvent(harness, replay));
    yield* service.sweep;
    yield* service.drain;

    const detail = yield* service.get({ taskId: root.taskId });
    expect(detail.task.status).toBe("running");
    expect(detail.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(detail.children.map((handoff) => [handoff.status, handoff.resultSummary])).toEqual([
      ["delivered", "Fixed."],
    ]);
    const rootStarts = turnStarts(harness).filter((command) => command.threadId === rootThread);
    expect(rootStarts.length).toBe(2);

    // Every task turn is marked server-authored at the source.
    const markerOf = (command: (typeof rootStarts)[number]) => {
      const record = command.message.context?.records[0];
      return record !== undefined && "payload" in record ? record.payload : undefined;
    };
    expect(markerOf(rootStarts[0]!)).toMatchObject({
      taskId: root.taskId,
      attempt: 1,
      turn: "start",
      source: "user",
      delegatorBotId: null,
      children: [],
    });
    expect(markerOf(rootStarts[1]!)).toEqual({
      taskId: root.taskId,
      attempt: 2,
      turn: "continuation",
      source: "user",
      title: "Root requeue",
      delegatorBotId: null,
      children: [
        { taskId: child.taskId, botId: botId("developer"), title: "Fix it", status: "completed" },
      ],
    });
    const childStart = turnStarts(harness).find((command) => command.threadId === childThread)!;
    expect(childStart.message.text.startsWith("[Delegated task from Assistant]")).toBe(true);
    expect(markerOf(childStart)).toMatchObject({
      taskId: child.taskId,
      turn: "start",
      source: "delegation",
      title: "Fix it",
      delegatorBotId: botId("assistant"),
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

/** The turns a task's own thread was asked to start, oldest first. */
const startsOn = (harness: Harness, threadId: ThreadId) =>
  turnStarts(harness).filter((command) => command.threadId === threadId);

/** Opens the root's turn and returns a helper that delegates from it. */
const rootDelegating = (harness: Harness, root: PersonalTask) =>
  Effect.gen(function* () {
    const rootThread = threadOf(root);
    const turnId = yield* beginTurn(harness, rootThread);
    const service = yield* PersonalTaskService.PersonalTaskService;
    const delegate = (bot: BotKey, title: string) =>
      service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId(bot),
        brief: brief(title),
      });
    return { rootThread, turnId, delegate };
  });

it.effect("a finished child is delivered at once while its sibling is still running", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("as-they-finish");
    const { rootThread, turnId, delegate } = yield* rootDelegating(harness, root);
    const fast = yield* delegate("developer", "Fast part");
    const slow = yield* delegate("researcher", "Slow part");
    yield* endTurn(harness, rootThread, turnId, "Delegated both.");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");

    const fastThread = threadOf(yield* reload(fast.taskId));
    const slowThread = threadOf(yield* reload(slow.taskId));
    yield* runTurn(harness, fastThread, "Fast result.");

    // The fast result reaches the parent right away; the slow child still runs.
    expect((yield* reload(slow.taskId)).status).toBe("running");
    expect((yield* reload(root.taskId)).status).toBe("running");
    const first = startsOn(harness, rootThread).at(-1)!;
    expect(
      first.message.text.startsWith("[Task continuation] These delegated tasks have finished."),
    ).toBe(true);
    expect(first.message.text).toContain("Fast result.");
    expect(first.message.text).toContain("Still running: Slow part.");
    expect(first.message.text).toContain("Their results will follow");
    expect(first.message.text).not.toContain("give your final answer");

    // Ending that continuation turn parks the task again; it does not complete
    // or send anything up.
    yield* runTurn(harness, rootThread, "Got the fast part, waiting for the slow one.");
    const parked = yield* reload(root.taskId);
    expect(parked.status).toBe("waiting_for_agent");
    expect(parked.result).toBeNull();
    expect(startsOn(harness, rootThread).length).toBe(2);

    yield* runTurn(harness, slowThread, "Slow result.");
    expect((yield* reload(root.taskId)).status).toBe("running");
    const second = startsOn(harness, rootThread).at(-1)!;
    expect(startsOn(harness, rootThread).length).toBe(3);
    expect(second.message.text).toContain("Your delegated tasks have finished.");
    expect(second.message.text).toContain("give your final answer");
    expect(second.message.text).toContain("Slow result.");
    expect(second.message.text).not.toContain("Fast result.");

    // Replays of either child's terminal session and a sweep deliver nothing again.
    for (const thread of [fastThread, slowThread]) {
      yield* service.ingestDomainEvent(sessionEvent(harness, harness.sessions.get(thread)!));
    }
    yield* service.sweep;
    yield* service.drain;
    expect(startsOn(harness, rootThread).length).toBe(3);

    // The task completes only after the last child's result was delivered.
    yield* runTurn(harness, rootThread, "All done.");
    const done = yield* reload(root.taskId);
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ summary: "All done." });
    const detail = yield* service.get({ taskId: root.taskId });
    expect(detail.children.map((handoff) => handoff.status)).toEqual(["delivered", "delivered"]);
    expect(detail.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("children finishing during the parent's turn come back in one continuation", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("during-turn");
    const { rootThread, turnId, delegate } = yield* rootDelegating(harness, root);
    const one = yield* delegate("developer", "Part one");
    const two = yield* delegate("researcher", "Part two");
    const three = yield* delegate("planner", "Part three");
    yield* service.drain;

    // Two children finish while the parent's own turn is still running.
    yield* runTurn(harness, threadOf(yield* reload(one.taskId)), "One done.");
    yield* runTurn(harness, threadOf(yield* reload(two.taskId)), "Two done.");
    expect((yield* reload(root.taskId)).status).toBe("running");
    expect(startsOn(harness, rootThread).length).toBe(1);

    // When the turn ends, both are delivered together, ahead of the third.
    yield* endTurn(harness, rootThread, turnId, "Delegated three.");
    expect((yield* reload(root.taskId)).status).toBe("running");
    expect(startsOn(harness, rootThread).length).toBe(2);
    const continuation = startsOn(harness, rootThread).at(-1)!;
    expect(continuation.message.text).toContain("One done.");
    expect(continuation.message.text).toContain("Two done.");
    expect(continuation.message.text).toContain("Still running: Part three.");
    const marker = continuation.message.context?.records[0];
    expect(marker).toMatchObject({ kind: "personal-task", payload: { turn: "continuation" } });
    const markedChildren =
      marker !== undefined && "payload" in marker
        ? (marker.payload as { children: ReadonlyArray<{ taskId: string; status: string }> })
            .children
        : [];
    expect(markedChildren.map((child) => [child.taskId, child.status]).toSorted()).toEqual(
      [
        [one.taskId, "completed"],
        [two.taskId, "completed"],
      ].toSorted(),
    );

    yield* runTurn(harness, rootThread, "Two of three in.");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");
    yield* runTurn(harness, threadOf(yield* reload(three.taskId)), "Three done.");
    expect(startsOn(harness, rootThread).length).toBe(3);
    expect(startsOn(harness, rootThread).at(-1)!.message.text).toContain("Three done.");
    yield* runTurn(harness, rootThread, "Everything in.");
    expect((yield* reload(root.taskId)).status).toBe("completed");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a child finishing while the parent is queued joins the same continuation", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("queued-merge");
    const { rootThread, turnId, delegate } = yield* rootDelegating(harness, root);
    const one = yield* delegate("developer", "Part one");
    const two = yield* delegate("researcher", "Part two");
    yield* delegate("planner", "Part three");
    yield* endTurn(harness, rootThread, turnId, "Delegated three.");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");

    // The user is chatting in the parent's thread, so the parent cannot start.
    const userTurn = yield* beginTurn(harness, rootThread);
    yield* runTurn(harness, threadOf(yield* reload(one.taskId)), "One done.");
    expect((yield* reload(root.taskId)).status).toBe("queued");
    yield* runTurn(harness, threadOf(yield* reload(two.taskId)), "Two done.");
    expect((yield* reload(root.taskId)).status).toBe("queued");
    expect(startsOn(harness, rootThread).length).toBe(1);

    yield* endTurn(harness, rootThread, userTurn, "Sure.");
    yield* service.drain;
    expect((yield* reload(root.taskId)).status).toBe("running");
    expect(startsOn(harness, rootThread).length).toBe(2);
    const merged = startsOn(harness, rootThread).at(-1)!.message.text;
    expect(merged).toContain("One done.");
    expect(merged).toContain("Two done.");
    expect(merged).toContain("Still running: Part three.");
    const detail = yield* service.get({ taskId: root.taskId });
    expect(detail.children.map((handoff) => handoff.status).toSorted()).toEqual([
      "delivered",
      "delivered",
      "pending",
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a failed or interrupted child is delivered like a finished one", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("failed-child");
    const { rootThread, turnId, delegate } = yield* rootDelegating(harness, root);
    const failing = yield* delegate("developer", "Failing part");
    const stopped = yield* delegate("researcher", "Stopped part");
    const slow = yield* delegate("planner", "Slow part");
    yield* endTurn(harness, rootThread, turnId, "Delegated three.");

    yield* runTurn(harness, threadOf(yield* reload(failing.taskId)), "", {
      status: "error",
      lastError: "Tool crashed",
    });
    expect((yield* reload(failing.taskId)).status).toBe("failed");
    expect((yield* reload(root.taskId)).status).toBe("running");
    const first = startsOn(harness, rootThread).at(-1)!;
    expect(first.message.text).toContain("### Failing part (failed)");
    expect(first.message.text).toContain("Task failed: Tool crashed");
    // Sibling order is not fixed: handoffs created together tie on created_at.
    expect(first.message.text).toMatch(
      /Still running: (Stopped part, Slow|Slow part, Stopped) part\./,
    );
    expect(first.message.context?.records[0]).toMatchObject({
      payload: { children: [{ taskId: failing.taskId, status: "failed" }] },
    });
    yield* runTurn(harness, rootThread, "Noted the failure.");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");

    yield* runTurn(harness, threadOf(yield* reload(stopped.taskId)), "", {
      status: "interrupted",
    });
    expect((yield* reload(stopped.taskId)).status).toBe("interrupted");
    expect((yield* reload(root.taskId)).status).toBe("running");
    const second = startsOn(harness, rootThread).at(-1)!;
    expect(second.message.text).toContain("### Stopped part (interrupted)");
    expect(second.message.text).toContain("Task interrupted");
    expect(second.message.text).toContain("Still running: Slow part.");
    expect(second.message.text).not.toContain("Failing part");
    yield* runTurn(harness, rootThread, "Noted the interruption.");

    yield* runTurn(harness, threadOf(yield* reload(slow.taskId)), "Slow done.");
    expect(startsOn(harness, rootThread).at(-1)!.message.text).toContain(
      "Your delegated tasks have finished.",
    );
    yield* runTurn(harness, rootThread, "Wrapped up.");
    expect((yield* reload(root.taskId)).status).toBe("completed");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a nested parent continues per child and reports up only when it is done", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("nested");
    const rootThread = threadOf(root);
    const rootTurn = yield* beginTurn(harness, rootThread);
    const middle = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("developer"),
      brief: brief("Middle"),
    });
    yield* endTurn(harness, rootThread, rootTurn, "Delegated.");
    const middleThread = threadOf(yield* reload(middle.taskId));
    const middleTurn = yield* beginTurn(harness, middleThread);
    const fast = yield* service.delegate({
      parentTaskId: middle.taskId,
      targetBotId: botId("researcher"),
      brief: brief("Deep fast"),
    });
    const slow = yield* service.delegate({
      parentTaskId: middle.taskId,
      targetBotId: botId("planner"),
      brief: brief("Deep slow"),
    });
    expect(fast.depth).toBe(2);
    yield* endTurn(harness, middleThread, middleTurn, "Delegated deeper.");
    expect((yield* reload(middle.taskId)).status).toBe("waiting_for_agent");

    yield* runTurn(harness, threadOf(yield* reload(fast.taskId)), "Deep fast result.");
    expect((yield* reload(middle.taskId)).status).toBe("running");
    const partial = startsOn(harness, middleThread).at(-1)!.message.text;
    expect(partial).toContain("Deep fast result.");
    expect(partial).toContain("Still running: Deep slow.");
    // The intermediate turn neither completes the middle task nor reports up.
    yield* runTurn(harness, middleThread, "Partial: fast part in.");
    const parked = yield* reload(middle.taskId);
    expect(parked.status).toBe("waiting_for_agent");
    expect(parked.result).toBeNull();
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");
    expect(startsOn(harness, rootThread).length).toBe(1);

    yield* runTurn(harness, threadOf(yield* reload(slow.taskId)), "Deep slow result.");
    expect((yield* reload(middle.taskId)).status).toBe("running");
    expect(startsOn(harness, middleThread).at(-1)!.message.text).toContain(
      "Your delegated tasks have finished.",
    );
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");
    yield* runTurn(harness, middleThread, "Middle complete.");

    // Only now does the root hear from the middle task, once.
    expect((yield* reload(middle.taskId)).status).toBe("completed");
    expect((yield* reload(root.taskId)).status).toBe("running");
    expect(startsOn(harness, rootThread).length).toBe(2);
    const rootContinuation = startsOn(harness, rootThread).at(-1)!.message.text;
    expect(rootContinuation).toContain("Middle complete.");
    expect(rootContinuation).not.toContain("Partial: fast part in.");
    yield* runTurn(harness, rootThread, "Root done.");
    expect((yield* reload(root.taskId)).status).toBe("completed");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it("the task-turn marker survives persistence decoding and never reaches the provider", () => {
  const marker = {
    taskId: PersonalTaskId.make("task-1"),
    attempt: 2,
    turn: "continuation" as const,
    source: "user" as const,
    title: "Root",
    delegatorBotId: null,
    children: [
      {
        taskId: PersonalTaskId.make("task-2"),
        botId: botId("developer"),
        title: "Fix it",
        status: "completed" as const,
      },
    ],
  };
  const context = PersonalTaskService.personalTaskMessageContext(marker);
  // Same codec as projection_thread_messages.context_json, i.e. a replay.
  const codec = Schema.fromJsonString(OrchestrationMessageContext);
  const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(context));
  const record = decoded.records[0]!;
  expect(record.kind).toBe(PERSONAL_TASK_MESSAGE_CONTEXT_KIND);
  expect("payload" in record ? record.payload : null).toEqual(marker);
  const text = "[Task continuation] Your delegated tasks have finished.";
  expect(projectComposerContextForProvider({ text, records: decoded.records })).toBe(text);
});

it.effect("cancel cascades by task id, interrupts live turns and keeps completed children", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("cancel");
    const rootThread = threadOf(root);
    const rootTurn = yield* beginTurn(harness, rootThread);
    const done = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("developer"),
      brief: brief("Quick part"),
    });
    const slow = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("researcher"),
      brief: brief("Slow part"),
    });
    yield* endTurn(harness, rootThread, rootTurn, "Delegated both.");
    yield* runTurn(harness, threadOf(yield* reload(done.taskId)), "Quick part done.");
    // The quick result continues the root at once; it parks again for the slow part.
    yield* runTurn(harness, rootThread, "Waiting for the slow part.");

    const slowThread = threadOf(yield* reload(slow.taskId));
    const slowTurn = yield* beginTurn(harness, slowThread);
    const grandchild = yield* service.delegate({
      parentTaskId: slow.taskId,
      targetBotId: botId("planner"),
      brief: brief("Sub part"),
    });
    yield* service.drain;
    const grandchildThread = threadOf(yield* reload(grandchild.taskId));
    const grandchildTurn = yield* beginTurn(harness, grandchildThread);

    const cancelled = yield* service.cancel({ taskId: root.taskId });
    yield* service.drain;

    expect(cancelled.status).toBe("cancelled");
    expect((yield* reload(done.taskId)).status).toBe("completed");
    expect((yield* reload(slow.taskId)).status).toBe("cancelled");
    expect((yield* reload(grandchild.taskId)).status).toBe("cancelled");
    expect(
      interrupts(harness)
        .map((command) => [command.threadId, command.turnId])
        .toSorted(),
    ).toEqual(
      [
        [slowThread, slowTurn],
        [grandchildThread, grandchildTurn],
      ].toSorted(),
    );
    // Nothing is left occupying a slot or waiting to run.
    const active = (yield* service.list({ statuses: ["queued", "running"] })).tasks;
    expect(active).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("retry of a failed task creates attempt 2 on the same thread", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("retry");
    const thread = threadOf(root);
    yield* runTurn(harness, thread, "", { status: "error", lastError: "Tool crashed" });
    const failed = yield* reload(root.taskId);
    expect([failed.status, failed.errorCategory, failed.errorMessage]).toEqual([
      "failed",
      "provider_error",
      "Tool crashed",
    ]);

    const notRetryable = yield* Effect.flip(
      service.retry({ taskId: (yield* createRoot("other", "planner")).taskId }),
    );
    expect(notRetryable.message).toContain("Only failed, interrupted or cancelled");

    yield* service.retry({ taskId: root.taskId });
    yield* service.drain;
    const detail = yield* service.get({ taskId: root.taskId });
    expect(detail.task.status).toBe("running");
    expect(detail.attempts.map((attempt) => [attempt.attempt, attempt.endedAt === null])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(detail.attempts[1]!.providerThreadId).toBe(thread);
    const retryStart = turnStarts(harness).findLast((command) => command.threadId === thread)!;
    expect(retryStart.message.text).toContain("Retry, attempt 2.");
  }).pipe(Effect.provide(makeLayer(harness)));
});

const LOST = "No conversation found with session ID: 0a1b2c3d-1111-2222-3333-444455556666";

it.effect("a renewal after a lost conversation continues the same attempt", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("renewal");
    const thread = threadOf(root);

    // The resumed session answers with the error first, and only then does the app start a fresh one.
    yield* runTurn(harness, thread, "", { status: "error", lastError: LOST });
    yield* service.sweep;
    yield* service.drain;
    expect((yield* reload(root.taskId)).status).toBe("running");

    // The renewed turn runs and replies: the task completes, on its first attempt.
    yield* TestClock.adjust("10 seconds");
    yield* runTurn(harness, thread, "Read the logs: nothing wrong.");
    const done = yield* reload(root.taskId);
    expect([done.status, done.errorCategory]).toEqual(["completed", null]);
    expect((yield* service.get({ taskId: root.taskId })).attempts.length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "the stream error that follows a failed resume is part of the renewal, not a new failure",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("renewal-sequence");
      const thread = threadOf(root);

      // What a throwaway server captured (1.60.41 QA): the resume answers "No conversation found",
      // the CLI exits, the SDK's stream then fails with an error of its own, and only after that
      // does the app's fresh session start and answer.
      const turnId = yield* beginTurn(harness, thread);
      yield* endTurn(harness, thread, turnId, "", { status: "error", lastError: LOST });
      yield* TestClock.adjust("300 millis");
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "error",
          activeTurnId: null,
          lastError: "Claude runtime stream failed.",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );
      yield* TestClock.adjust("2 seconds");
      yield* service.sweep;
      yield* service.drain;
      expect((yield* reload(root.taskId)).status).toBe("running");

      yield* runTurn(harness, thread, "Read the logs: nothing wrong.");
      const done = yield* reload(root.taskId);
      expect([done.status, done.errorCategory]).toEqual(["completed", null]);
      expect((yield* service.get({ taskId: root.taskId })).attempts.length).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("a stream error with no failed resume before it still fails the task at once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("stream-error-alone");
    yield* runTurn(harness, threadOf(root), "", {
      status: "error",
      lastError: "Claude runtime stream failed.",
    });
    const failed = yield* reload(root.taskId);
    expect([failed.status, failed.errorMessage]).toEqual([
      "failed",
      "Claude runtime stream failed.",
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a lost conversation with no renewal still fails the task once the wait is over", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("no-renewal");
    yield* runTurn(harness, threadOf(root), "", { status: "error", lastError: LOST });
    yield* service.sweep;
    yield* service.drain;
    expect((yield* reload(root.taskId)).status).toBe("running");

    yield* TestClock.adjust(`${PersonalTaskService.PERSONAL_TASKS_RENEWAL_WAIT_MS + 1_000} millis`);
    yield* service.sweep;
    yield* service.drain;
    const failed = yield* reload(root.taskId);
    expect([failed.status, failed.errorCategory, failed.errorMessage]).toEqual([
      "failed",
      "provider_error",
      LOST,
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a renewal that fails with another error fails the task at once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("renewal-fails");
    const thread = threadOf(root);
    yield* runTurn(harness, thread, "", { status: "error", lastError: LOST });
    expect((yield* reload(root.taskId)).status).toBe("running");
    yield* runTurn(harness, thread, "", { status: "error", lastError: "Tool crashed" });
    const failed = yield* reload(root.taskId);
    expect([failed.status, failed.errorMessage]).toEqual(["failed", "Tool crashed"]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

const codexAt = (effort: string) => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
  options: [{ id: "reasoningEffort", value: effort }],
});

it.effect("a delegated task turn carries the target bot's model selection and effort", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const bots = yield* PersonalBotService.PersonalBotService;
    yield* bots.update({ botId: botId("developer"), modelSelection: codexAt("max") });
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("effort-delegate");
    const turnId = yield* beginTurn(harness, threadOf(root));
    const child = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("developer"),
      brief: brief("Think hard"),
    });
    yield* endTurn(harness, threadOf(root), turnId, "Waiting on Developer.");
    yield* service.drain;

    const childThread = threadOf(yield* reload(child.taskId));
    const childStart = turnStarts(harness).find((command) => command.threadId === childThread)!;
    expect(childStart.modelSelection).toEqual(codexAt("max"));
    // The delegator's own turn keeps the delegator's selection.
    const rootStart = turnStarts(harness).find((command) => command.threadId === threadOf(root))!;
    expect(rootStart.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a task turn uses the bot's current effort, not the one its thread was created with",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const bots = yield* PersonalBotService.PersonalBotService;
      yield* bots.update({ botId: botId("assistant"), modelSelection: codexAt("medium") });
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("effort-edit");
      const thread = threadOf(root);
      expect(turnStarts(harness).at(-1)!.modelSelection).toEqual(codexAt("medium"));
      yield* runTurn(harness, thread, "", { status: "error", lastError: "Tool crashed" });

      yield* bots.update({ botId: botId("assistant"), modelSelection: codexAt("max") });
      yield* service.retry({ taskId: root.taskId });
      yield* service.drain;
      const retryStart = turnStarts(harness).findLast((command) => command.threadId === thread)!;
      expect(retryStart.message.text).toContain("Retry, attempt 2.");
      expect(retryStart.modelSelection).toEqual(codexAt("max"));
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("rate limits back off 1m, 5m, 15m and then fail the task", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("rate-limit");
    const thread = threadOf(root);
    const limited = { status: "error" as const, lastError: "429 Too Many Requests" };

    for (const minutes of PersonalTaskService.PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES) {
      yield* runTurn(harness, thread, "", limited);
      const waiting = yield* reload(root.taskId);
      expect(waiting.status).toBe("rate_limited");
      const now = yield* DateTime.now;
      expect(DateTime.toEpochMillis(waiting.availableAt!) - DateTime.toEpochMillis(now)).toBe(
        minutes * 60_000,
      );
      // Not claimable before the backoff elapses.
      yield* service.sweep;
      yield* service.drain;
      expect((yield* reload(root.taskId)).status).toBe("rate_limited");
      yield* TestClock.adjust(`${minutes} minutes`);
      yield* service.sweep;
      yield* service.drain;
      expect((yield* reload(root.taskId)).status).toBe("running");
    }

    yield* runTurn(harness, thread, "", limited);
    const failed = yield* reload(root.taskId);
    expect([failed.status, failed.errorCategory]).toEqual(["failed", "rate_limited"]);
    expect((yield* service.get({ taskId: root.taskId })).attempts.length).toBe(4);
  }).pipe(Effect.provide(makeLayer(harness)));
});

/** A provider wait as the adapter reports it; `waitMs` null = no reset reported. */
const providerWait = (
  kind: "rate_limited" | "retrying",
  now: DateTime.Utc,
  waitMs: number | null,
): NonNullable<OrchestrationSession["providerRetry"]> => ({
  kind,
  provider: "claudeAgent",
  observedAt: DateTime.formatIso(now),
  ...(waitMs === null
    ? {}
    : { retryAt: DateTime.formatIso(DateTime.add(now, { milliseconds: waitMs })) }),
  reason: kind === "rate_limited" ? "HTTP 429 rate_limit" : "HTTP 502 api_error",
});

/** Re-sends the running session with a wait on it, like an api_retry heartbeat. */
const waitOnProvider = (
  harness: Harness,
  threadId: ThreadId,
  turnId: TurnId,
  retry: NonNullable<OrchestrationSession["providerRetry"]>,
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* setSession(
      harness,
      makeSession({
        threadId,
        status: "running",
        activeTurnId: turnId,
        providerRetry: retry,
        updatedAt: now,
      }),
    );
  });

it.effect(
  "a long provider wait interrupts the turn, frees its slot and waits for the reset",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const limited = yield* createRoot("wait-limited", "assistant");
      for (let slot = 2; slot <= PersonalTaskService.PERSONAL_TASKS_CONCURRENCY; slot++) {
        yield* createRoot(`wait-busy-${slot}`, "developer");
      }
      const queued = yield* createRoot("wait-queued", "researcher");
      expect(queued.status).toBe("queued");

      const thread = threadOf(limited);
      const turnId = yield* beginTurn(harness, thread);
      const now = yield* DateTime.now;
      const retry = providerWait("rate_limited", now, 6 * 60 * 60_000);
      yield* waitOnProvider(harness, thread, turnId, retry);

      const paused = yield* reload(limited.taskId);
      expect([paused.status, paused.errorCategory]).toEqual(["rate_limited", "rate_limited"]);
      expect(DateTime.toEpochMillis(paused.availableAt!)).toBe(Date.parse(retry.retryAt!));
      expect(paused.errorMessage).toContain("HTTP 429 rate_limit");
      const interrupt = interrupts(harness).at(-1)!;
      expect([interrupt.threadId, interrupt.turnId]).toEqual([thread, turnId]);
      const detail = yield* service.get({ taskId: limited.taskId });
      expect(
        detail.attempts.map((attempt) => [attempt.endedAt !== null, attempt.resumable]),
      ).toEqual([[true, true]]);
      // The freed slot goes to the queued task.
      expect((yield* reload(queued.taskId)).status).toBe("running");

      // Later heartbeats for the paused turn change nothing.
      const interruptCount = interrupts(harness).length;
      yield* waitOnProvider(harness, thread, turnId, retry);
      expect(interrupts(harness).length).toBe(interruptCount);

      // Not claimable after the 1 minute unreported-limit backoff: it waits for the reset.
      yield* TestClock.adjust("5 minutes");
      yield* service.sweep;
      yield* service.drain;
      expect((yield* reload(limited.taskId)).status).toBe("rate_limited");
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("short retries stay with the provider; unreported limits back off", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("wait-short");
    const thread = threadOf(root);
    const turnId = yield* beginTurn(harness, thread);
    const now = yield* DateTime.now;

    yield* waitOnProvider(harness, thread, turnId, providerWait("retrying", now, 30_000));
    yield* waitOnProvider(harness, thread, turnId, providerWait("rate_limited", now, 90_000));
    expect((yield* reload(root.taskId)).status).toBe("running");
    expect(interrupts(harness)).toEqual([]);

    yield* waitOnProvider(harness, thread, turnId, providerWait("rate_limited", now, null));
    const paused = yield* reload(root.taskId);
    expect(paused.status).toBe("rate_limited");
    expect(DateTime.toEpochMillis(paused.availableAt!) - DateTime.toEpochMillis(now)).toBe(60_000);
    expect(paused.errorMessage).toContain("did not report");
    expect(interrupts(harness).length).toBe(1);

    // The retried turn fails on a limit the adapter recognised (Codex usage
    // limit): the task waits for the reset it reported, not the backoff.
    yield* TestClock.adjust("1 minute");
    yield* service.sweep;
    yield* service.drain;
    expect((yield* reload(root.taskId)).status).toBe("running");
    const later = yield* DateTime.now;
    const limit = providerWait("rate_limited", later, 3 * 60 * 60_000);
    yield* runTurn(harness, thread, "", {
      status: "error",
      lastError: "Codex usage limit reached.",
      providerRetry: limit,
    });
    const waiting = yield* reload(root.taskId);
    expect(waiting.status).toBe("rate_limited");
    expect(DateTime.toEpochMillis(waiting.availableAt!)).toBe(Date.parse(limit.retryAt!));
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("subscribe replays current tasks as upserts", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("subscribe");
    const events = yield* service.subscribe.pipe(Stream.take(1), Stream.runCollect);
    expect([...events].map((event) => [event.type, event.task.taskId])).toEqual([
      ["upsert", root.taskId],
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("the replay keeps every unfinished task and only the newest finished ones", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
    const sql = yield* SqlClient.SqlClient;
    const older = yield* createRoot("replay-older");
    const newer = yield* createRoot("replay-newer");
    const running = yield* createRoot("replay-running");
    yield* sql`
      UPDATE personal_tasks SET status = 'completed', created_at = '2026-09-01T00:00:00.000Z'
      WHERE task_id = ${older.taskId}
    `;
    yield* sql`
      UPDATE personal_tasks SET status = 'completed', created_at = '2026-09-02T00:00:00.000Z'
      WHERE task_id = ${newer.taskId}
    `;
    yield* sql`
      UPDATE personal_tasks SET status = 'running', created_at = '2026-08-01T00:00:00.000Z'
      WHERE task_id = ${running.taskId}
    `;
    const replay = yield* repository.listForReplay(1);
    // Newest first; the old running task is kept even though it is the oldest row.
    expect(replay.map((task) => task.taskId)).toEqual([newer.taskId, running.taskId]);
    const all = yield* repository.listTasks({});
    expect(all.length).toBe(3);
  }).pipe(Effect.provide(makeLayer(harness)));
});

const encodeResult = Schema.encodeSync(Schema.fromJsonString(PersonalTaskResult));

/** Marks `task` finished at `createdAt`, with an optional result and thread/parent. */
const finish = (
  task: PersonalTask,
  createdAt: string,
  extra: { readonly result?: string; readonly parent?: PersonalTask } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE personal_tasks
      SET status = 'completed', created_at = ${createdAt},
        result_json = ${extra.result === undefined ? null : encodeResult({ summary: extra.result })},
        parent_task_id = ${extra.parent?.taskId ?? null}
      WHERE task_id = ${task.taskId}
    `;
  });

it.effect("the feed sends summaries: no bodies, a short result preview", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const done = yield* createRoot("summary-done");
    const longResult = "x".repeat(PersonalTaskService.TASK_SUMMARY_RESULT_PREVIEW_CHARS + 500);
    yield* finish(done, "2026-09-01T00:00:00.000Z", { result: longResult });

    const [event] = yield* service.subscribe.pipe(Stream.take(1), Stream.runCollect);
    expect(event!.task).toMatchObject({
      taskId: done.taskId,
      title: done.title,
      objective: "",
      acceptanceCriteria: "",
      expectedOutput: "",
      detailOmitted: true,
    });
    expect(event!.task.result!.summary).toBe(
      `${"x".repeat(PersonalTaskService.TASK_SUMMARY_RESULT_PREVIEW_CHARS)}…`,
    );
    // The detail keeps everything.
    const full = yield* reload(done.taskId);
    expect(full.objective).toBe("Do the summary-done thing.");
    expect(full.result!.summary).toBe(longResult);
    expect(full.detailOmitted).toBeUndefined();
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("history pages through finished tasks older than the feed, without gaps", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const tasks: Array<PersonalTask> = [];
    for (let day = 1; day <= 5; day++) {
      const task = yield* createRoot(`history-${day}`);
      yield* finish(task, `2026-09-0${day}T00:00:00.000Z`);
      tasks.push(task);
    }
    const open = yield* createRoot("history-open");

    const first = yield* service.history({ limit: 2 });
    expect(first.tasks.map((task) => task.taskId)).toEqual([tasks[4]!.taskId, tasks[3]!.taskId]);
    expect(first.hasMore).toBe(true);
    expect(first.tasks.every((task) => task.detailOmitted === true)).toBe(true);
    const second = yield* service.history({ before: tasks[3]!.taskId, limit: 2 });
    expect(second.tasks.map((task) => task.taskId)).toEqual([tasks[2]!.taskId, tasks[1]!.taskId]);
    const last = yield* service.history({ before: tasks[1]!.taskId, limit: 2 });
    expect(last.tasks.map((task) => task.taskId)).toEqual([tasks[0]!.taskId]);
    expect(last.hasMore).toBe(false);
    // Unfinished tasks are the feed's, never history's.
    const everything = yield* service.history({ limit: 100 });
    expect(everything.tasks.map((task) => task.taskId)).not.toContain(open.taskId);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("related returns a thread's tasks and their delegated children", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const parent = yield* createRoot("related-parent");
    const child = yield* createRoot("related-child", "developer");
    const unrelated = yield* createRoot("related-other", "researcher");
    yield* finish(parent, "2026-09-01T00:00:00.000Z");
    yield* finish(child, "2026-09-02T00:00:00.000Z", { result: "done", parent });

    const byThread = yield* service.related({ threadId: threadOf(parent) });
    expect(byThread.tasks.map((task) => task.taskId).toSorted()).toEqual(
      [parent.taskId, child.taskId].toSorted(),
    );
    expect(byThread.tasks.every((task) => task.detailOmitted === true)).toBe(true);

    const byId = yield* service.related({ taskIds: [child.taskId, unrelated.taskId] });
    expect(byId.tasks.map((task) => task.taskId).toSorted()).toEqual(
      [child.taskId, unrelated.taskId].toSorted(),
    );
    expect((yield* service.related({})).tasks).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a task placed in a chat waits out the user's turn and starts when it ends", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const bots = yield* PersonalBotService.PersonalBotService;
    const chat = "chat-user" as ThreadId;
    yield* bots.createThread({ botId: botId("assistant"), threadId: chat });
    // The user is mid-turn in the chat; no task owns that turn.
    const userTurn = yield* beginTurn(harness, chat);
    const before = turnStarts(harness).length;

    const task = yield* service.createTask({
      idempotencyKey: "routine:in-chat:1",
      botId: botId("assistant"),
      title: "Routine in chat",
      objective: "Report.",
      source: "routine",
      threadId: chat,
    });
    yield* service.drain;
    expect((yield* reload(task.taskId)).status).toBe("queued");
    expect(turnStarts(harness).length).toBe(before);

    // The user's turn ends: the session event alone starts the run, no sweep.
    yield* endTurn(harness, chat, userTurn, "Done.");
    const started = turnStarts(harness).slice(before);
    expect(started.map((command) => command.threadId)).toEqual([chat]);
    const running = yield* reload(task.taskId);
    expect(running.status).toBe("running");
    expect(running.threadId).toBe(chat);
  }).pipe(Effect.provide(makeLayer(harness)));
});

const threadCreates = (harness: Harness) =>
  harness.dispatched.flatMap((command) => (command.type === "thread.create" ? [command] : []));

it.effect("a delegated task's new chat is named after the task", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("named-root");
    const child = yield* service.delegate({
      parentTaskId: root.taskId,
      targetBotId: botId("developer"),
      brief: brief("Fix the login redirect"),
    });
    yield* service.drain;
    const running = yield* reload(child.taskId);

    const creates = threadCreates(harness);
    expect(creates.find((command) => command.threadId === root.threadId)?.title).toBe(
      "Root named-root",
    );
    expect(creates.find((command) => command.threadId === running.threadId)?.title).toBe(
      "Fix the login redirect",
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a routine run in a new chat names the chat after the routine", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const task = yield* service.createTask({
      idempotencyKey: "routine:digest:1",
      botId: botId("assistant"),
      title: "  Morning\n news   digest ",
      objective: "Summarise the news.",
      source: "routine",
    });
    yield* service.drain;
    const running = yield* reload(task.taskId);

    const creates = threadCreates(harness).filter(
      (command) => command.threadId === running.threadId,
    );
    expect(creates.map((command) => command.title)).toEqual(["Morning news digest"]);
    expect(harness.dispatched.some((command) => command.type === "thread.meta.update")).toBe(false);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a routine run into the chat it was made in leaves that chat's title alone", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const bots = yield* PersonalBotService.PersonalBotService;
    const chat = "chat-routine-home" as ThreadId;
    yield* bots.createThread({ botId: botId("assistant"), threadId: chat });
    const createsBefore = threadCreates(harness).length;

    const task = yield* service.createTask({
      idempotencyKey: "routine:home:1",
      botId: botId("assistant"),
      title: "Daily check-in",
      objective: "Check in.",
      source: "routine",
      threadId: chat,
    });
    yield* service.drain;

    expect((yield* reload(task.taskId)).threadId).toBe(chat);
    expect(threadCreates(harness).length).toBe(createsBefore);
    expect(threadCreates(harness).find((command) => command.threadId === chat)?.title).toBe(
      "New chat",
    );
    expect(
      harness.dispatched.some(
        (command) =>
          (command.type === "thread.meta.update" ||
            command.type === "thread.title.generate.complete") &&
          command.threadId === chat,
      ),
    ).toBe(false);
  }).pipe(Effect.provide(makeLayer(harness)));
});

describe("a task bound to a chat the owner archived", () => {
  const OLD = "chat-main-old" as ThreadId;
  const NEW = "chat-main-new" as ThreadId;

  const seedChats = (harness: Harness, chats: ReadonlyArray<readonly [ThreadId, string]>) =>
    Effect.gen(function* () {
      const bots = yield* PersonalBotService.PersonalBotService;
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      for (const [threadId, title] of chats) {
        yield* bots.createThread({ botId: botId("assistant"), threadId });
        yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES (${threadId}, 'project', ${title}, ${now}, ${now})
        `;
        harness.titles.set(threadId, title);
        yield* setSession(
          harness,
          makeSession({ threadId, status: "ready", activeTurnId: null, updatedAt: now }),
        );
      }
    });

  const archivedAt = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{ readonly archivedAt: string | null }>`
        SELECT archived_at AS "archivedAt" FROM personal_bot_threads WHERE thread_id = ${threadId}
      `;
      return row?.archivedAt ?? null;
    });

  const renames = (harness: Harness) =>
    harness.dispatched.filter((command) => command.type === "thread.meta.update");

  it.effect(
    "a chat request waiting on its children wakes in the bot's open chat of the same name, and the archived chat stays archived",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const bots = yield* PersonalBotService.PersonalBotService;
        yield* seedChats(harness, [
          [OLD, "Main"],
          [NEW, "Main"],
        ]);
        yield* bots.archiveThread({ threadId: OLD, archived: true });
        const before = turnStarts(harness).length;

        const task = yield* service.createTask({
          idempotencyKey: "user:wake:1",
          botId: botId("assistant"),
          title: "Wake",
          objective: "Report back.",
          source: "user",
          threadId: OLD,
        });
        yield* service.drain;

        const started = turnStarts(harness).slice(before);
        expect(started.map((command) => command.threadId)).toEqual([NEW]);
        const running = yield* reload(task.taskId);
        expect(running.threadId).toBe(NEW);
        expect(yield* archivedAt(OLD)).not.toBeNull();
        expect(renames(harness)).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "with no open chat at all the task gets one new chat and the archived chat stays put",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const bots = yield* PersonalBotService.PersonalBotService;
        yield* seedChats(harness, [[OLD, "Main"]]);
        yield* bots.archiveThread({ threadId: OLD, archived: true });
        const before = turnStarts(harness).length;
        const createsBefore = threadCreates(harness).length;

        const task = yield* service.createTask({
          idempotencyKey: "user:wake:2",
          botId: botId("assistant"),
          title: "Wake",
          objective: "Report back.",
          source: "user",
          threadId: OLD,
        });
        yield* service.drain;

        const started = turnStarts(harness).slice(before);
        expect(started).toHaveLength(1);
        expect(started[0]!.threadId).not.toBe(OLD);
        expect(threadCreates(harness).length).toBe(createsBefore + 1);
        expect((yield* reload(task.taskId)).threadId).toBe(started[0]!.threadId);
        expect(yield* archivedAt(OLD)).not.toBeNull();
        expect(renames(harness)).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "a task whose chat belongs to another bot is not moved into that bot's open chat",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const bots = yield* PersonalBotService.PersonalBotService;
        // The chats are the assistant's; the task is the developer's.
        yield* seedChats(harness, [
          [OLD, "Main"],
          [NEW, "Main"],
        ]);
        yield* bots.archiveThread({ threadId: OLD, archived: true });
        const before = turnStarts(harness).length;

        yield* service.createTask({
          idempotencyKey: "user:wake:other-bot",
          botId: botId("developer"),
          title: "Wake",
          objective: "Report back.",
          source: "user",
          threadId: OLD,
        });
        yield* service.drain;

        const started = turnStarts(harness)
          .slice(before)
          .map((command) => command.threadId);
        // Never the assistant's open chat.
        expect(started).not.toContain(NEW);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "a group member's relay thread is not judged: the task stays in it, archived or not",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const bots = yield* PersonalBotService.PersonalBotService;
        const sql = yield* SqlClient.SqlClient;
        yield* seedChats(harness, [
          [OLD, "Main"],
          [NEW, "Main"],
        ]);
        yield* sql`
          INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
          VALUES ('g-1', 'Team', 'g-thread', 8, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO personal_group_members (group_id, bot_id, thread_id, role, sort_order, joined_at)
          VALUES ('g-1', ${botId("assistant")}, ${OLD}, 'member', 0, '2026-09-25T00:00:00.000Z')
        `;
        yield* bots.archiveThread({ threadId: OLD, archived: true });
        const before = turnStarts(harness).length;

        yield* service.createTask({
          idempotencyKey: "user:wake:relay",
          botId: botId("assistant"),
          title: "Wake",
          objective: "Report back.",
          source: "user",
          threadId: OLD,
        });
        yield* service.drain;

        expect(
          turnStarts(harness)
            .slice(before)
            .map((command) => command.threadId),
        ).toEqual([OLD]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("a delegated task's own chat is its work item and is left where it is", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const bots = yield* PersonalBotService.PersonalBotService;
      yield* seedChats(harness, [
        [OLD, "Build it"],
        [NEW, "Build it"],
      ]);
      yield* bots.archiveThread({ threadId: OLD, archived: true });
      const before = turnStarts(harness).length;

      yield* service.createTask({
        idempotencyKey: "delegation:work:1",
        botId: botId("assistant"),
        title: "Build it",
        objective: "Build.",
        source: "delegation",
        threadId: OLD,
      });
      yield* service.drain;

      expect(
        turnStarts(harness)
          .slice(before)
          .map((command) => command.threadId),
      ).toEqual([OLD]);
    }).pipe(Effect.provide(makeLayer(harness)));
  });
});

const claudeOpus = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "medium" }],
};

it.effect(
  "steer delivers into the running turn with the bot's selection and keeps the task",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const bots = yield* PersonalBotService.PersonalBotService;
      yield* bots.update({ botId: botId("assistant"), modelSelection: claudeOpus });
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("steer-running");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const startsBefore = turnStarts(harness).length;

      const steered = yield* service.steer({
        taskId: root.taskId,
        fromName: "CTO",
        message: "Only check the login page.",
      });

      expect(steered.outcome).toBe("steered");
      const steer = turnStarts(harness).at(-1)!;
      expect(turnStarts(harness).length).toBe(startsBefore + 1);
      expect(steer.threadId).toBe(thread);
      expect(steer.message.text).toBe("Update from CTO: Only check the login page.");
      expect(steer.message.messageId.startsWith("personal-task-steer-")).toBe(true);
      expect(steer.modelSelection).toEqual(claudeOpus);
      // Not a new attempt: the same task keeps running on the same turn.
      const detail = yield* service.get({ taskId: root.taskId });
      expect(detail.task.status).toBe("running");
      expect(detail.attempts).toHaveLength(1);
      expect(interrupts(harness)).toHaveLength(0);
      const recorded = yield* service.steers({ taskId: root.taskId });
      expect(recorded.map((entry) => [entry.text, entry.deliveredAt !== null])).toEqual([
        ["Update from CTO: Only check the login page.", true],
      ]);

      // The turn ends as usual and the task completes once, with no replay.
      yield* endTurn(harness, thread, turnId, "Login page checked.");
      const done = yield* reload(root.taskId);
      expect(done.status).toBe("completed");
      expect(done.result).toEqual({ summary: "Login page checked." });
      expect(turnStarts(harness).length).toBe(startsBefore + 1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("steer keeps a prefix the sender already wrote instead of doubling it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const bots = yield* PersonalBotService.PersonalBotService;
    yield* bots.update({ botId: botId("assistant"), modelSelection: claudeOpus });
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("steer-prefixed");
    const thread = threadOf(root);
    yield* beginTurn(harness, thread);

    yield* service.steer({
      taskId: root.taskId,
      fromName: "CTO",
      message: "update from cto: Only check the login page.",
    });
    expect(turnStarts(harness).at(-1)!.message.text).toBe(
      "update from cto: Only check the login page.",
    );
    // A different name in the text is still the sender's own prefix.
    yield* service.steer({
      taskId: root.taskId,
      fromName: "CTO",
      message: "Update from Harout: Skip the tests.",
    });
    expect(turnStarts(harness).at(-1)!.message.text).toBe("Update from Harout: Skip the tests.");
    // Text that merely mentions the phrase later still gets the prefix.
    yield* service.steer({
      taskId: root.taskId,
      fromName: "CTO",
      message: "Please send an Update from you: when done.",
    });
    expect(turnStarts(harness).at(-1)!.message.text).toBe(
      "Update from CTO: Please send an Update from you: when done.",
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("steer on a queued task lands in the brief it starts with", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    // Running roots fill every slot, so the next one waits in the queue.
    const first = yield* createRoot("steer-slot-1");
    for (let slot = 2; slot <= PersonalTaskService.PERSONAL_TASKS_CONCURRENCY; slot++) {
      yield* createRoot(`steer-slot-${slot}`, "developer");
    }
    const queued = yield* createRoot("steer-queued", "researcher");
    expect(queued.status).toBe("queued");

    const steered = yield* service.steer({
      taskId: queued.taskId,
      fromName: "CTO",
      message: "Narrow it to the iPhone layout.",
    });
    expect(steered.outcome).toBe("queued");
    expect((yield* service.steers({ taskId: queued.taskId }))[0]!.deliveredAt).toBeNull();

    yield* runTurn(harness, threadOf(first), "First done.");
    const started = yield* reload(queued.taskId);
    expect(started.status).toBe("running");
    const start = turnStarts(harness).find((command) => command.threadId === started.threadId)!;
    expect(start.message.text.startsWith("[Task from you]")).toBe(true);
    expect(start.message.text).toContain("Do the steer-queued thing.");
    expect(start.message.text).toContain(
      "Updates since this task was handed over:\n\nUpdate from CTO: Narrow it to the iPhone layout.",
    );
    expect((yield* service.steers({ taskId: queued.taskId }))[0]!.deliveredAt).not.toBeNull();
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "steer reopens a completed child in its own chat and its result returns to the parent",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("reopen-completed");
      const { rootThread, turnId, delegate } = yield* rootDelegating(harness, root);
      const child = yield* delegate("developer", "Animate avatars");
      yield* endTurn(harness, rootThread, turnId, "Delegated.");
      const childThread = threadOf(yield* reload(child.taskId));
      yield* runTurn(harness, childThread, "Paused halfway: two of four avatars done.");
      yield* runTurn(harness, rootThread, "Frontend stopped halfway.");
      expect((yield* reload(root.taskId)).status).toBe("completed");
      expect((yield* reload(child.taskId)).status).toBe("completed");

      const steered = yield* service.steer({
        taskId: child.taskId,
        fromName: "Assistant",
        message: "Finish the other two avatars.",
      });
      expect(steered.outcome).toBe("reopened");
      expect(steered.task).toMatchObject({ status: "queued", threadId: childThread, result: null });
      yield* service.drain;

      // The same task, chat and thread continue: attempt 2 on the child's thread.
      const detail = yield* service.get({ taskId: child.taskId });
      expect(detail.task).toMatchObject({ status: "running", threadId: childThread });
      expect(detail.attempts.map((attempt) => [attempt.attempt, attempt.providerThreadId])).toEqual(
        [
          [1, childThread],
          [2, childThread],
        ],
      );
      expect(detail.handoff?.status).toBe("pending");
      expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");
      const continuation = startsOn(harness, childThread).at(-1)!;
      expect(continuation.message.text).toBe(
        [
          "[Task continuation]",
          "Update from Assistant: Finish the other two avatars.",
          PersonalTaskService.reopenNote("completed"),
          "Continue the task below.",
          `Task id: ${child.taskId}`,
          "Title: Animate avatars",
          "Objective:\nAnimate avatars objective",
        ].join("\n\n"),
      );
      expect(yield* service.steers({ taskId: child.taskId })).toEqual([
        expect.objectContaining({ text: "Update from Assistant: Finish the other two avatars." }),
      ]);

      // Its new result goes back to the parent, in the parent's own chat.
      yield* runTurn(harness, childThread, "All four avatars animate.");
      expect((yield* reload(child.taskId)).result?.summary).toBe("All four avatars animate.");
      expect((yield* reload(root.taskId)).status).toBe("running");
      const parentTurn = startsOn(harness, rootThread).at(-1)!;
      expect(parentTurn.message.text).toContain("### Animate avatars (completed)");
      expect(parentTurn.message.text).toContain("All four avatars animate.");
      expect(parentTurn.message.text).toContain("give your final answer");
      yield* runTurn(harness, rootThread, "Avatars done.");
      const finalRoot = yield* service.get({ taskId: root.taskId });
      expect(finalRoot.task).toMatchObject({
        status: "completed",
        result: { summary: "Avatars done." },
      });
      expect(finalRoot.children.map((handoff) => handoff.status)).toEqual(["delivered"]);

      // No new chat or thread anywhere: every turn ran on the two original ones.
      expect(new Set(turnStarts(harness).map((command) => command.threadId))).toEqual(
        new Set([rootThread, childThread]),
      );
      expect(startsOn(harness, childThread)).toHaveLength(2);
      expect(startsOn(harness, rootThread)).toHaveLength(3);
      expect((yield* service.list({})).tasks).toHaveLength(2);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("steer reopens an interrupted or cancelled child while its parent still runs", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("reopen-stopped");
    const { rootThread, turnId, delegate } = yield* rootDelegating(harness, root);
    const interrupted = yield* delegate("developer", "Interrupted part");
    const cancelled = yield* delegate("researcher", "Cancelled part");
    yield* endTurn(harness, rootThread, turnId, "Delegated two.");

    const interruptedThread = threadOf(yield* reload(interrupted.taskId));
    yield* runTurn(harness, interruptedThread, "", { status: "interrupted" });
    expect((yield* reload(interrupted.taskId)).status).toBe("interrupted");
    const cancelledThread = threadOf(yield* reload(cancelled.taskId));
    yield* service.cancel({ taskId: cancelled.taskId });
    yield* service.drain;
    // The root is taking in the two results in its continuation turn.
    expect((yield* reload(root.taskId)).status).toBe("running");

    for (const [task, thread, status] of [
      [interrupted, interruptedThread, "interrupted"],
      [cancelled, cancelledThread, "cancelled"],
    ] as const) {
      const steered = yield* service.steer({
        taskId: task.taskId,
        fromName: "Assistant",
        message: "Pick it up again.",
      });
      expect(steered.outcome).toBe("reopened");
      yield* service.drain;
      const reopened = yield* reload(task.taskId);
      expect(reopened).toMatchObject({ status: "running", threadId: thread, errorMessage: null });
      expect(startsOn(harness, thread).at(-1)!.message.text).toContain(
        PersonalTaskService.reopenNote(status),
      );
    }
    // The running parent is left alone and parks on the reopened children.
    expect((yield* reload(root.taskId)).status).toBe("running");
    yield* runTurn(harness, rootThread, "Noted both.");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");

    yield* runTurn(harness, interruptedThread, "Interrupted part done.");
    yield* runTurn(harness, rootThread, "One back.");
    yield* runTurn(harness, cancelledThread, "Cancelled part done.");
    const last = startsOn(harness, rootThread).at(-1)!;
    expect(last.message.text).toContain("Cancelled part done.");
    yield* runTurn(harness, rootThread, "Both done.");
    expect((yield* reload(root.taskId)).status).toBe("completed");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a reopen does not count toward the per-request delegation limit", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("reopen-limit");
    const { rootThread, turnId, delegate } = yield* rootDelegating(harness, root);
    const children = [];
    for (let index = 1; index <= PersonalTaskService.PERSONAL_TASKS_DEFAULT_MAX_CHILDREN; index++) {
      children.push(yield* delegate(index % 2 === 0 ? "developer" : "researcher", `Part ${index}`));
    }
    yield* endTurn(harness, rootThread, turnId, "Delegated the limit.");
    const limited = yield* delegate("planner", "One too many").pipe(Effect.flip);
    expect(limited.message).toContain("Delegation limit reached");

    const first = children[0]!;
    yield* service.cancel({ taskId: first.taskId });
    const steered = yield* service.steer({
      taskId: first.taskId,
      fromName: "Assistant",
      message: "Carry on.",
    });
    expect(steered.outcome).toBe("reopened");
    expect((yield* service.list({ rootTaskId: root.taskId })).tasks).toHaveLength(
      1 + PersonalTaskService.PERSONAL_TASKS_DEFAULT_MAX_CHILDREN,
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a reopened task waits for a free slot like any queued task", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const done = yield* createRoot("reopen-slot-done", "researcher");
    yield* runTurn(harness, threadOf(done), "Done early.");
    const first = yield* createRoot("reopen-slot-1");
    for (let slot = 2; slot <= PersonalTaskService.PERSONAL_TASKS_CONCURRENCY; slot++) {
      yield* createRoot(`reopen-slot-${slot}`, "developer");
    }

    yield* service.steer({ taskId: done.taskId, fromName: "Assistant", message: "More please." });
    yield* service.drain;
    expect((yield* reload(done.taskId)).status).toBe("queued");

    yield* runTurn(harness, threadOf(first), "First done.");
    expect(yield* reload(done.taskId)).toMatchObject({
      status: "running",
      threadId: threadOf(done),
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("steer refuses to reopen a task whose bot was deleted", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("reopen-deleted", "developer");
    yield* runTurn(harness, threadOf(root), "Done.");
    yield* (yield* PersonalBotService.PersonalBotService).remove({ botId: botId("developer") });
    const before = turnStarts(harness).length;

    const error = yield* service
      .steer({ taskId: root.taskId, fromName: "CTO", message: "One more thing." })
      .pipe(Effect.flip);

    expect(error.message).toContain("bot has been deleted");
    expect((yield* reload(root.taskId)).status).toBe("completed");
    expect(turnStarts(harness).length).toBe(before);
    expect(yield* service.steers({ taskId: root.taskId })).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("steer does not wake a task waiting for the user; it rides the resume", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("steer-waiting");
    const thread = threadOf(root);
    const turnId = yield* beginTurn(harness, thread);
    yield* service.waitForUser({ taskId: root.taskId });
    yield* endTurn(harness, thread, turnId, "Need a key.");

    const steered = yield* service.steer({
      taskId: root.taskId,
      fromName: "CTO",
      message: "Skip the billing part.",
    });
    expect(steered.outcome).toBe("queued");
    yield* service.sweep;
    yield* service.drain;
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_user");

    yield* service.resumeFromUser({
      taskId: root.taskId,
      noteId: "secret:1",
      note: "The key is saved.",
      restartSession: false,
    });
    yield* service.drain;
    const continuation = turnStarts(harness).at(-1)!;
    expect(continuation.message.text).toContain("[Task continuation]");
    expect(continuation.message.text).toContain("Update from CTO: Skip the billing part.");
    expect(continuation.message.text).toContain("The key is saved.");
  }).pipe(Effect.provide(makeLayer(harness)));
});

// Background work a Claude turn leaves running (Backend task 7739ab64, 26 Sep:
// the gates ran with run_in_background, the turn ended on "Waiting on the
// server gate notification." and that became the result, while the real
// report came in turns Claude Code ran by itself after the gates finished).

const CLAUDE = "claudeAgent";

const claudeSession = (input: {
  readonly threadId: ThreadId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId: TurnId | null;
  readonly updatedAt: string;
  readonly providerName?: string;
}): OrchestrationSession => ({
  ...makeSession(input),
  providerName: input.providerName ?? CLAUDE,
});

const beginClaudeTurn = (harness: Harness, threadId: ThreadId, providerName = CLAUDE) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const turnId = TurnId.make(`turn-${threadId}-${harness.sequence + 1}`);
    yield* setSession(
      harness,
      claudeSession({
        threadId,
        status: "running",
        activeTurnId: turnId,
        updatedAt: now,
        providerName,
      }),
    );
    return turnId;
  });

const endClaudeTurn = (
  harness: Harness,
  threadId: ThreadId,
  turnId: TurnId,
  reply: string,
  providerName = CLAUDE,
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    harness.messages.set(threadId, [
      ...(harness.messages.get(threadId) ?? []),
      {
        messageId: MessageId.make(`msg-${turnId}`),
        threadId,
        turnId,
        role: "assistant",
        text: reply,
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    yield* setSession(
      harness,
      claudeSession({
        threadId,
        status: "ready",
        activeTurnId: null,
        updatedAt: now,
        providerName,
      }),
    );
  });

/** What ingestion records for a task_started / task_notification pair. */
const backgroundStarted = (threadId: ThreadId, taskId: string) =>
  Effect.gen(function* () {
    const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
    liveness.recordTaskLiveness({
      threadId,
      taskId,
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
  });

const backgroundFinished = (threadId: ThreadId, taskId: string) =>
  Effect.gen(function* () {
    const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
    liveness.recordTaskLiveness({
      threadId,
      taskId,
      taskType: "local_bash",
      status: "completed",
      kind: "completed",
    });
  });

const sweepNow = Effect.gen(function* () {
  const service = yield* PersonalTaskService.PersonalTaskService;
  yield* service.sweep;
  yield* service.drain;
});

it.effect(
  "a Claude turn that ends with background work running keeps the task running; the follow-up turn completes it with its reply",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("bg-follow-up");
      const thread = threadOf(root);

      const first = yield* beginClaudeTurn(harness, thread);
      // A foreground command starts and ends inside the turn: not waited for.
      yield* backgroundStarted(thread, "bvref5quh");
      yield* backgroundFinished(thread, "bvref5quh");
      yield* backgroundStarted(thread, "bahddbmzw");
      yield* endClaudeTurn(harness, thread, first, "Waiting on the server gate notification.");

      expect((yield* reload(root.taskId)).status).toBe("running");
      yield* sweepNow;
      // Still unfinished, which is what the idle check before a restart reads;
      // the reply so far shows as a preview marked with when the wait began.
      expect(yield* reload(root.taskId)).toMatchObject({
        status: "running",
        result: {
          summary: "Waiting on the server gate notification.",
          waitingOnBackgroundSince: expect.any(String),
        },
      });

      // Claude Code's own turn: progress, the gates still running.
      yield* TestClock.adjust("1 minute");
      const progress = yield* beginClaudeTurn(harness, thread);
      yield* endClaudeTurn(
        harness,
        thread,
        progress,
        "`src/personal` passed. Still waiting on tsc.",
      );
      expect((yield* reload(root.taskId)).status).toBe("running");

      // The gates finish and the turn Claude Code runs for them reports.
      yield* TestClock.adjust("3 minutes");
      yield* backgroundFinished(thread, "bahddbmzw");
      const report = yield* beginClaudeTurn(harness, thread);
      yield* endClaudeTurn(harness, thread, report, "## Branch ready: all gates green.");

      const done = yield* reload(root.taskId);
      expect(done.status).toBe("completed");
      // Every turn's reply is kept, earliest first; the wait mark is gone.
      expect(done.result).toEqual({
        summary: PersonalTaskService.composeTaskReplies([
          "Waiting on the server gate notification.",
          "`src/personal` passed. Still waiting on tsc.",
          "## Branch ready: all gates green.",
        ]),
      });
      expect(done.result?.summary).toBe(
        [
          "Waiting on the server gate notification.",
          `${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\n\`src/personal\` passed. Still waiting on tsc.`,
          `${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\n## Branch ready: all gates green.`,
        ].join("\n\n"),
      );
      const detail = yield* service.get({ taskId: root.taskId });
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]!.turnId).toBe(report);
      expect(turnStarts(harness)).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "background work that never finishes closes the task after the cap, with its latest reply and a note",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("bg-cap");
      const thread = threadOf(root);

      const turnId = yield* beginClaudeTurn(harness, thread);
      yield* backgroundStarted(thread, "dev-server");
      yield* endClaudeTurn(harness, thread, turnId, "The dev server is up on :3000.");

      yield* TestClock.adjust(
        `${PersonalTaskService.PERSONAL_TASK_BACKGROUND_WAIT_MS - 60_000} millis`,
      );
      yield* sweepNow;
      expect((yield* reload(root.taskId)).status).toBe("running");

      yield* TestClock.adjust("1 minute");
      yield* sweepNow;
      const done = yield* reload(root.taskId);
      expect(done.status).toBe("completed");
      expect(done.result).toEqual({
        summary: `The dev server is up on :3000.\n\n${PersonalTaskService.backgroundCapNote(1)}`,
      });
      expect(PersonalTaskService.backgroundCapNote(1)).toContain(
        "a background command the bot started was still running 20 minutes after this reply",
      );
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("a Claude turn with no background work completes its task exactly as before", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("bg-none");
    const thread = threadOf(root);
    const turnId = yield* beginClaudeTurn(harness, thread);
    yield* backgroundStarted(thread, "foreground-1");
    yield* backgroundFinished(thread, "foreground-1");
    yield* endClaudeTurn(harness, thread, turnId, "Done, gates green.");

    const done = yield* reload(root.taskId);
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ summary: "Done, gates green." });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "when the background work ends and no follow-up turn comes, the latest reply stands after a minute",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("bg-no-follow-up");
      const thread = threadOf(root);
      const turnId = yield* beginClaudeTurn(harness, thread);
      yield* backgroundStarted(thread, "b-quiet");
      yield* endClaudeTurn(harness, thread, turnId, "Kicked off the export; it reports when done.");

      yield* TestClock.adjust("2 minutes");
      yield* backgroundFinished(thread, "b-quiet");
      yield* sweepNow;
      expect((yield* reload(root.taskId)).status).toBe("running");

      yield* TestClock.adjust(
        `${PersonalTaskService.PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS} millis`,
      );
      yield* sweepNow;
      const done = yield* reload(root.taskId);
      expect(done.status).toBe("completed");
      expect(done.result).toEqual({ summary: "Kicked off the export; it reports when done." });
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("a steer reaches a task that is waiting on background work, and its turn reports", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("bg-steer");
    const thread = threadOf(root);
    const first = yield* beginClaudeTurn(harness, thread);
    yield* backgroundStarted(thread, "b-gates");
    yield* endClaudeTurn(harness, thread, first, "Waiting on the gates.");
    const startsBefore = turnStarts(harness).length;

    const steered = yield* service.steer({
      taskId: root.taskId,
      fromName: "CTO",
      message: "Skip the web gates.",
    });
    expect(steered.outcome).toBe("steered");
    const delivered = turnStarts(harness);
    expect(delivered).toHaveLength(startsBefore + 1);
    expect(delivered.at(-1)).toMatchObject({ threadId: thread });
    expect(delivered.at(-1)!.message.text).toBe("Update from CTO: Skip the web gates.");

    // The steer's turn runs; the gates finish while it does.
    yield* TestClock.adjust("1 minute");
    const steerTurn = yield* beginClaudeTurn(harness, thread);
    yield* backgroundFinished(thread, "b-gates");
    yield* endClaudeTurn(harness, thread, steerTurn, "Server gates green; web gates skipped.");

    const done = yield* reload(root.taskId);
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({
      summary: PersonalTaskService.composeTaskReplies([
        "Waiting on the gates.",
        "Server gates green; web gates skipped.",
      ]),
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a task not waiting on anything still refuses a steer between turns", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("bg-steer-idle");
    const thread = threadOf(root);
    yield* setSession(
      harness,
      claudeSession({
        threadId: thread,
        status: "ready",
        activeTurnId: null,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    const error = yield* service
      .steer({ taskId: root.taskId, fromName: "CTO", message: "Hello?" })
      .pipe(Effect.flip);
    expect(error.message).toContain("between turns");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("Codex turns do not wait on background tasks", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("bg-codex");
    const thread = threadOf(root);
    const turnId = yield* beginClaudeTurn(harness, thread, "codex");
    yield* backgroundStarted(thread, "codex-child");
    yield* endClaudeTurn(harness, thread, turnId, "Codex done.", "codex");
    const done = yield* reload(root.taskId);
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ summary: "Codex done." });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "background work already running in the chat before the task started is not waited for",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const thread = ThreadId.make("thread-with-dev-server");
      yield* backgroundStarted(thread, "old-dev-server");
      const task = yield* service.createTask({
        idempotencyKey: "bg-baseline",
        botId: botId("assistant"),
        title: "Follow-up in the same chat",
        objective: "Check the page again.",
        threadId: thread,
      });
      yield* service.drain;
      expect((yield* reload(task.taskId)).status).toBe("running");

      const turnId = yield* beginClaudeTurn(harness, thread);
      yield* endClaudeTurn(harness, thread, turnId, "Page checked.");
      const done = yield* reload(task.taskId);
      expect(done.status).toBe("completed");
      expect(done.result).toEqual({ summary: "Page checked." });
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "a session that stops while the task waits on background work completes it with the reply",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("bg-stopped");
      const thread = threadOf(root);
      const turnId = yield* beginClaudeTurn(harness, thread);
      yield* backgroundStarted(thread, "b-long");
      yield* endClaudeTurn(harness, thread, turnId, "Started the long run.");
      expect((yield* reload(root.taskId)).status).toBe("running");

      yield* TestClock.adjust("1 minute");
      yield* setSession(
        harness,
        claudeSession({
          threadId: thread,
          status: "stopped",
          activeTurnId: null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );
      const done = yield* reload(root.taskId);
      expect(done.status).toBe("completed");
      expect(
        done.result?.summary.startsWith("Started the long run.\n\n(Closed by the task runner:"),
      ).toBe(true);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

// Backend task 84a37cf7, 2 Oct (rainhb 0.13.1): the bot ended a turn with its
// full report and two questions while a Monitor ran; when the Monitor expired,
// Claude Code's follow-up turn said "nothing pending" and that two-line reply
// became the result. The report must stay, and show while the task waits.

const FULL_REPORT =
  "## rainhb 0.13.1 ready\n\nAll gates green.\n\nQuestions for CTO:\n1. Ship Tuesday?\n2. Keep the old route?";
const MONITOR_NOTE =
  "That notice is only the compute-measurement monitor expiring. Nothing is pending on my side.";

it.effect(
  "a short follow-up after the Monitor expires does not replace the full report; the report shows while the task waits",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("bg-incident");
      const thread = threadOf(root);

      const first = yield* beginClaudeTurn(harness, thread);
      yield* backgroundStarted(thread, "monitor-compute");
      yield* endClaudeTurn(harness, thread, first, FULL_REPORT);

      // While it waits: still running, the report is the preview, marked.
      yield* sweepNow;
      const waiting = yield* reload(root.taskId);
      expect(waiting.status).toBe("running");
      expect(waiting.result?.summary).toBe(FULL_REPORT);
      const since = waiting.result?.waitingOnBackgroundSince;
      expect(since).toBeDefined();
      expect(Number.isFinite(Date.parse(since!))).toBe(true);
      // The feed and list summaries keep the mark with the preview.
      expect(PersonalTaskService.toTaskSummary(waiting).result).toEqual({
        summary: FULL_REPORT,
        waitingOnBackgroundSince: since,
      });

      // 16 minutes on, the Monitor expires and Claude Code replies.
      yield* TestClock.adjust("16 minutes");
      yield* backgroundFinished(thread, "monitor-compute");
      const followUp = yield* beginClaudeTurn(harness, thread);
      yield* endClaudeTurn(harness, thread, followUp, MONITOR_NOTE);

      const done = yield* reload(root.taskId);
      expect(done.status).toBe("completed");
      expect(done.result).toEqual({
        summary: `${FULL_REPORT}\n\n${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\n${MONITOR_NOTE}`,
      });
      expect(done.result?.waitingOnBackgroundSince).toBeUndefined();
      expect(turnStarts(harness)).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("a follow-up that is still waiting adds to the preview without losing the report", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("bg-preview-grows");
    const thread = threadOf(root);
    const first = yield* beginClaudeTurn(harness, thread);
    yield* backgroundStarted(thread, "b-slow");
    yield* endClaudeTurn(harness, thread, first, FULL_REPORT);
    const firstSince = (yield* reload(root.taskId)).result?.waitingOnBackgroundSince;

    yield* TestClock.adjust("2 minutes");
    const second = yield* beginClaudeTurn(harness, thread);
    yield* endClaudeTurn(harness, thread, second, "Still running.");
    const waiting = yield* reload(root.taskId);
    expect(waiting.status).toBe("running");
    expect(waiting.result?.summary).toBe(
      `${FULL_REPORT}\n\n${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\nStill running.`,
    );
    // The wait began with the first turn, not the latest one.
    expect(waiting.result?.waitingOnBackgroundSince).toBe(firstSince);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a task closed by the background cap keeps the report and its follow-ups", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("bg-cap-follow-up");
    const thread = threadOf(root);
    const first = yield* beginClaudeTurn(harness, thread);
    yield* backgroundStarted(thread, "dev-server");
    yield* endClaudeTurn(harness, thread, first, FULL_REPORT);

    yield* TestClock.adjust("5 minutes");
    const second = yield* beginClaudeTurn(harness, thread);
    yield* endClaudeTurn(harness, thread, second, "Server still up.");

    yield* TestClock.adjust(
      `${PersonalTaskService.PERSONAL_TASK_BACKGROUND_WAIT_MS - 60_000} millis`,
    );
    yield* sweepNow;
    expect((yield* reload(root.taskId)).status).toBe("running");
    yield* TestClock.adjust("1 minute");
    yield* sweepNow;

    const done = yield* reload(root.taskId);
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({
      summary: `${FULL_REPORT}\n\n${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\nServer still up.\n\n${PersonalTaskService.backgroundCapNote(1)}`,
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a session that stops while waiting keeps the report and the follow-ups", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("bg-stopped-follow-up");
    const thread = threadOf(root);
    const first = yield* beginClaudeTurn(harness, thread);
    yield* backgroundStarted(thread, "b-long");
    yield* endClaudeTurn(harness, thread, first, FULL_REPORT);

    yield* TestClock.adjust("1 minute");
    const second = yield* beginClaudeTurn(harness, thread);
    yield* endClaudeTurn(harness, thread, second, "Progress: half done.");

    yield* TestClock.adjust("1 minute");
    yield* setSession(
      harness,
      claudeSession({
        threadId: thread,
        status: "stopped",
        activeTurnId: null,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    const done = yield* reload(root.taskId);
    expect(done.status).toBe("completed");
    expect(done.result?.summary).toBe(
      `${FULL_REPORT}\n\n${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\nProgress: half done.\n\n(Closed by the task runner: the bot's session ended while background work it started was still running.)`,
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("an interrupted task keeps the reply but not the waiting mark", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("bg-interrupted");
    const thread = threadOf(root);
    const first = yield* beginClaudeTurn(harness, thread);
    yield* backgroundStarted(thread, "b-int");
    yield* endClaudeTurn(harness, thread, first, FULL_REPORT);
    expect((yield* reload(root.taskId)).result?.waitingOnBackgroundSince).toBeDefined();

    yield* TestClock.adjust("1 minute");
    yield* setSession(
      harness,
      claudeSession({
        threadId: thread,
        status: "interrupted",
        activeTurnId: null,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    const ended = yield* reload(root.taskId);
    expect(ended.status).toBe("interrupted");
    expect(ended.result).toEqual({ summary: FULL_REPORT });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it("composeTaskReplies: is the reply itself when there is one, and empty when there is none", () => {
  expect(PersonalTaskService.composeTaskReplies(["Done."])).toBe("Done.");
  expect(PersonalTaskService.composeTaskReplies([])).toBe("");
  expect(PersonalTaskService.composeTaskReplies(["", "  "])).toBe("");
});

it("composeTaskReplies: skips blank replies and keeps the order", () => {
  expect(PersonalTaskService.composeTaskReplies(["A", "", "B", "C"])).toBe(
    `A\n\n${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\nB\n\n${PersonalTaskService.BACKGROUND_FOLLOW_UP_MARKER}\n\nC`,
  );
});

it("composeTaskReplies: trims the oldest follow-ups first and never the first report", () => {
  const max = PersonalTaskService.PERSONAL_TASK_RESULT_MAX_CHARS;
  const first = `FIRST ${"a".repeat(max / 2)}`;
  const old = `OLD ${"b".repeat(max / 3)}`;
  const middle = `MIDDLE ${"c".repeat(max / 3)}`;
  const newest = "NEWEST short reply";
  const composed = PersonalTaskService.composeTaskReplies([first, old, middle, newest]);
  expect(composed.length).toBeLessThanOrEqual(max);
  expect(composed.startsWith(first)).toBe(true);
  expect(composed.endsWith(newest)).toBe(true);
  expect(composed).not.toContain("OLD ");
  expect(composed).toContain("earlier follow-up");
});

it("composeTaskReplies: cuts the newest follow-up last when it alone is too long, leaving the first report whole", () => {
  const max = PersonalTaskService.PERSONAL_TASK_RESULT_MAX_CHARS;
  const first = `FIRST ${"a".repeat(max - 10_000)}`;
  const composed = PersonalTaskService.composeTaskReplies([first, "z".repeat(max)]);
  expect(composed.startsWith(first)).toBe(true);
  expect(composed.length).toBeLessThanOrEqual(max + 1);
  expect(composed.endsWith("…")).toBe(true);
});

it.effect("a chat resuming after a usage limit takes a slot from the same cap as tasks", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    // Two chats resume; the tasks get what is left of the five slots.
    expect(yield* service.reserveExternalSlot("chat-resume:a")).toBe(true);
    expect(yield* service.reserveExternalSlot("chat-resume:b")).toBe(true);
    // Holding a slot twice is still one slot.
    expect(yield* service.reserveExternalSlot("chat-resume:a")).toBe(true);
    const roots: Array<Effect.Success<ReturnType<typeof createRoot>>> = [];
    for (let slot = 1; slot <= PersonalTaskService.PERSONAL_TASKS_CONCURRENCY - 1; slot++) {
      roots.push(yield* createRoot(`slot-share-${slot}`, "developer"));
    }
    const statuses = () =>
      Effect.forEach(roots, (root) => reload(root.taskId).pipe(Effect.map((task) => task.status)));
    expect(yield* statuses()).toEqual(["running", "running", "running", "queued"]);
    // Every slot busy: another chat has to wait.
    expect(yield* service.reserveExternalSlot("chat-resume:c")).toBe(false);

    // A resumed chat's turn ends: its slot goes to the queued task.
    yield* service.releaseExternalSlot("chat-resume:a");
    yield* service.drain;
    expect(yield* statuses()).toEqual(["running", "running", "running", "running"]);
    expect(PersonalTaskService.PERSONAL_TASKS_CONCURRENCY).toBe(5);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a bot removed between the live check and the insert gets no task (createTask, delegate, relay)",
  () => {
    const harness = makeHarness();
    // The first list the service reads still shows the bot; the row is soft-deleted
    // right after, as a remove_bot that committed in between would do.
    const race = { victim: null as BotKey | null };
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const root = yield* service.createTask({
        idempotencyKey: "race-root",
        botId: botId("assistant"),
        title: "Root",
        objective: "Root objective",
      });

      race.victim = "developer";
      const delegated = yield* Effect.result(
        service.delegate({
          parentTaskId: root.taskId,
          targetBotId: botId("developer"),
          brief: brief("Child"),
        }),
      );
      expect(delegated._tag).toBe("Failure");
      expect((yield* bots.listBots()).some((bot) => bot.botId === botId("developer"))).toBe(false);

      race.victim = "planner";
      const created = yield* Effect.result(
        service.createTask({
          idempotencyKey: "race-create",
          botId: botId("planner"),
          title: "Late",
          objective: "Too late",
        }),
      );
      expect(created._tag).toBe("Failure");

      race.victim = "researcher";
      const relayed = yield* Effect.result(
        service.relay({
          idempotencyKey: "race-relay",
          botId: botId("researcher"),
          title: "Routine",
          text: "Late routine",
        }),
      );
      expect(relayed._tag).toBe("Failure");

      const all = (yield* service.list({})).tasks.map((task) => task.botId);
      expect(all).toEqual([botId("assistant")]);
    }).pipe(
      Effect.provide(
        makeLayer(harness, undefined, (bots) => ({
          ...bots,
          listBots: () =>
            bots.listBots().pipe(
              Effect.tap(() =>
                race.victim === null
                  ? Effect.void
                  : bots
                      .softDeleteBot({
                        botId: botId(race.victim),
                        deletedAt: DateTime.makeUnsafe("2026-09-29T12:00:00.000Z"),
                      })
                      .pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            race.victim = null;
                          }),
                        ),
                      ),
              ),
            ),
        })),
      ),
    );
  },
);

/** Runs an effect with an environment variable set, then puts it back. */
const withEnv = <A, E, R>(
  name: string,
  value: string | undefined,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }),
  );

/** The provider's last context-size report for a thread, as the ingestion records it. */
const reportContextTokens = (threadId: ThreadId, usedTokens: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES (${`ctx-${threadId}-${usedTokens}`}, ${threadId}, NULL, 'info', 'context-window.updated',
        'Context window updated', ${JSON.stringify({ usedTokens })}, ${at})
    `;
  });

/** The task marker a turn message carries. */
const markerOf = (command: { readonly message: { readonly context?: unknown } }) =>
  (
    command.message.context as unknown as {
      readonly records: ReadonlyArray<{ readonly payload: { readonly fresh?: boolean } }>;
    }
  ).records[0]!.payload;

const finishedRoot = (harness: Harness, key: string, reply: string) =>
  Effect.gen(function* () {
    const root = yield* createRoot(key);
    const thread = threadOf(root);
    yield* runTurn(harness, thread, reply);
    return { root, thread };
  });

describe("work record (1.60.41)", () => {
  it.effect(
    "a finished task keeps its result and the evidence it names; a steer is kept too",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const { root } = yield* finishedRoot(
          harness,
          "wr-end",
          "Shipped. QA report: C:/qa/report.md and the live check https://example.com/status.",
        );
        const record = yield* service.workRecord({ taskId: root.taskId });
        expect(record).toMatchObject({
          objective: "Do the wr-end thing.",
          lastStatus: "completed",
        });
        expect(record?.lastResult).toContain("Shipped. QA report");
        expect(record?.evidence.map((item) => item.ref)).toEqual([
          "https://example.com/status",
          "C:/qa/report.md",
        ]);
        yield* service.steer({
          taskId: root.taskId,
          fromName: "CTO",
          message: "Update from CTO: also check the dark theme.",
        });
        const after = yield* service.workRecord({ taskId: root.taskId });
        expect(after?.updates.map((update) => update.text)).toEqual(["also check the dark theme."]);
        // Visible on the task detail too.
        expect((yield* service.get({ taskId: root.taskId })).workRecord?.lastStatus).toBe(
          "completed",
        );
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("a bot's update adds decisions and evidence and replaces outstanding work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("wr-update");
      const first = yield* service.updateWorkRecord({
        taskId: root.taskId,
        patch: {
          decisions: ["Use the new index."],
          evidence: [{ label: "commit", ref: "abc1234" }],
          outstanding: ["Write tests", "Ship"],
          nextStep: "Write tests",
        },
      });
      expect(first.outstanding).toEqual(["Write tests", "Ship"]);
      const second = yield* service.updateWorkRecord({
        taskId: root.taskId,
        patch: { decisions: ["Skip the old index."], outstanding: ["Ship"], nextStep: "Ship" },
      });
      expect(second.decisions).toEqual(["Use the new index.", "Skip the old index."]);
      expect(second.outstanding).toEqual(["Ship"]);
      expect(second.nextStep).toBe("Ship");
      expect(second.evidence).toEqual([{ label: "commit", ref: "abc1234" }]);
      // The task is found from its chat.
      const found = yield* service.taskForThread({ threadId: threadOf(root) });
      expect(Option.map(found, (task) => task.taskId)).toEqual(Option.some(root.taskId));
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("never keeps a secret", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("wr-secret");
      const record = yield* service.updateWorkRecord({
        taskId: root.taskId,
        patch: { decisions: ["Login uses password: hunter2hunter2 on the box."], nextStep: "go" },
      });
      expect(JSON.stringify(record)).not.toContain("hunter2");
      expect(record.decisions[0]).toContain("[redacted]");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "a chat that saw a sensitive site in an earlier request hands the mark to the tasks it delegates",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const sql = yield* SqlClient.SqlClient;
        const store = makeSensitiveExposureStore(sql);
        const root = yield* createRoot("wr-carry");
        const turnId = yield* beginTurn(harness, threadOf(root));
        // The chat's own mark only, as from an earlier request: nothing under this request's root.
        yield* store.record([threadExposureKey(threadOf(root))], "source", "https://bank.example");
        yield* store.record([threadExposureKey(threadOf(root))], "approved", "https://ok.example");
        expect([...(yield* store.read([rootExposureKey(root.rootTaskId)])).sources]).toEqual([]);

        const child = yield* service.delegate({
          parentTaskId: root.taskId,
          targetBotId: botId("developer"),
          brief: brief("Look it up"),
        });
        yield* endTurn(harness, threadOf(root), turnId, "Waiting on Developer.");
        yield* service.drain;

        // The tree carries the mark (not the approval), so the child keeps no record of what it reads.
        const carried = yield* store.read([rootExposureKey(root.rootTaskId)]);
        expect([...carried.sources]).toEqual(["https://bank.example"]);
        expect([...carried.approved]).toEqual([]);
        const refused = yield* Effect.flip(
          service.updateWorkRecord({ taskId: child.taskId, patch: { nextStep: "x" } }),
        );
        expect(refused.message).toContain("sensitive");
        yield* runTurn(harness, threadOf(yield* reload(child.taskId)), "Balance is 1,234.");
        expect(yield* service.workRecord({ taskId: child.taskId })).toBeNull();
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "a steer carries the steering chat's sensitive mark into the task's tree, whichever way it is delivered",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const sql = yield* SqlClient.SqlClient;
        const store = makeSensitiveExposureStore(sql);
        // The steering chat opened a sensitive site after it had delegated: its own keys carry it.
        const steerer = yield* createRoot("wr-steerer");
        yield* store.record(
          [threadExposureKey(threadOf(steerer))],
          "source",
          "https://bank.example",
        );
        yield* store.record(
          [threadExposureKey(threadOf(steerer))],
          "approved",
          "https://ok.example",
        );

        const steered = yield* createRoot("wr-steered");
        yield* runTurn(harness, threadOf(steered), "Done for now.");
        const rootKey = rootExposureKey(steered.rootTaskId);
        expect([...(yield* store.read([rootKey])).sources]).toEqual([]);
        const before = yield* service.workRecord({ taskId: steered.taskId });
        expect(before?.updates ?? []).toEqual([]);

        // Reopened by the steer: the mark arrives first, so the update is not written into the record.
        const outcome = yield* service.steer({
          taskId: steered.taskId,
          fromName: "CTO",
          message: "The balance is 1,234, carry on.",
          fromThreadId: threadOf(steerer),
        });
        expect(outcome.outcome).toBe("reopened");
        const carried = yield* store.read([rootKey]);
        expect([...carried.sources]).toEqual(["https://bank.example"]);
        expect([...carried.approved]).toEqual([]);
        const record = yield* service.workRecord({ taskId: steered.taskId });
        expect(JSON.stringify(record ?? {})).not.toContain("1,234");
        const refused = yield* Effect.flip(
          service.updateWorkRecord({ taskId: steered.taskId, patch: { nextStep: "x" } }),
        );
        expect(refused.message).toContain("sensitive");
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("a steer with no marked chat behind it is recorded as before", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const steerer = yield* createRoot("wr-steerer-clean");
      const steered = yield* createRoot("wr-steered-clean");
      yield* runTurn(harness, threadOf(steered), "Done for now.");
      yield* service.steer({
        taskId: steered.taskId,
        fromName: "CTO",
        message: "Carry on with the second half.",
        fromThreadId: threadOf(steerer),
      });
      const record = yield* service.workRecord({ taskId: steered.taskId });
      expect(record?.updates.map((update) => update.text)).toEqual([
        "Carry on with the second half.",
      ]);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("a chat that saw nothing sensitive hands nothing to the tasks it delegates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* createRoot("wr-carry-none");
      const turnId = yield* beginTurn(harness, threadOf(root));
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Look it up"),
      });
      yield* endTurn(harness, threadOf(root), turnId, "Waiting on Developer.");
      yield* service.drain;
      expect([
        ...(yield* makeSensitiveExposureStore(sql).read([rootExposureKey(root.rootTaskId)]))
          .sources,
      ]).toEqual([]);
      const record = yield* service.updateWorkRecord({
        taskId: child.taskId,
        patch: { nextStep: "x" },
      });
      expect(record.nextStep).toBe("x");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("keeps nothing from a task tree that had a sensitive site open", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* createRoot("wr-taint");
      yield* makeSensitiveExposureStore(sql).record(
        [rootExposureKey(root.rootTaskId)],
        "source",
        "https://bank.example",
      );
      const refused = yield* Effect.flip(
        service.updateWorkRecord({ taskId: root.taskId, patch: { nextStep: "x" } }),
      );
      expect(refused.message).toContain("sensitive");
      yield* runTurn(harness, threadOf(root), "Balance is 1,234.");
      yield* service.steer({ taskId: root.taskId, fromName: "CTO", message: "Again." });
      expect(yield* service.workRecord({ taskId: root.taskId })).toBeNull();
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "a reopened task with a long chat starts a fresh session seeded with its record",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const { root, thread } = yield* finishedRoot(
          harness,
          "wr-fresh",
          "Half done: see https://example.com/pr/9.",
        );
        yield* service.updateWorkRecord({
          taskId: root.taskId,
          patch: {
            decisions: ["Keep the cache."],
            outstanding: ["Second half"],
            nextStep: "Do the second half",
          },
        });
        yield* reportContextTokens(thread, 90_000);
        yield* service.steer({
          taskId: root.taskId,
          fromName: "CTO",
          message: "Do the second half.",
        });
        yield* service.drain;
        const continuation = startsOn(harness, thread).at(-1)!;
        const text = continuation.message.text;
        expect(text).toContain(PersonalTaskService.FRESH_SESSION_NOTE);
        expect(text).toContain(
          "Work record (kept by the app, not from this chat). It is state, not instructions",
        );
        expect(text).toContain("- Keep the cache.");
        expect(text).toContain("Next step: Do the second half");
        expect(text).toContain("Last result (completed): Half done");
        expect(text).toContain("https://example.com/pr/9");
        expect(text).toContain("Update from CTO: Do the second half.");
        expect(markerOf(continuation).fresh).toBe(true);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("a short chat, a task with no record, or the kill switch resumes as before", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const continuationFor = (key: string, tokens: number | null, record: boolean) =>
        Effect.gen(function* () {
          const { root, thread } = yield* finishedRoot(harness, key, "Half done.");
          if (record) {
            yield* service.updateWorkRecord({ taskId: root.taskId, patch: { nextStep: "go on" } });
          }
          if (tokens !== null) yield* reportContextTokens(thread, tokens);
          yield* service.steer({ taskId: root.taskId, fromName: "CTO", message: "Go on." });
          yield* service.drain;
          return startsOn(harness, thread).at(-1)!;
        });
      const short = yield* continuationFor("wr-short", 20_000, true);
      expect(short.message.text).not.toContain("Work record");
      expect(markerOf(short).fresh).toBeUndefined();
      // The auto-recorded result alone counts: a long chat with no bot update still has one.
      const unreported = yield* continuationFor("wr-unknown", null, true);
      expect(unreported.message.text).not.toContain("Work record");
      const off = yield* withEnv(
        "T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS",
        "off",
        continuationFor("wr-off", 150_000, true),
      );
      expect(off.message.text).not.toContain("Work record");
      const raised = yield* withEnv(
        "T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS",
        "200000",
        continuationFor("wr-raised", 150_000, true),
      );
      expect(raised.message.text).not.toContain("Work record");
      // The threshold is the owner's to set: lowered, the same chat starts fresh.
      const lowered = yield* withEnv(
        "T3CODE_PERSONAL_TASK_REOPEN_FRESH_TOKENS",
        "10000",
        continuationFor("wr-lowered", 20_000, true),
      );
      expect(lowered.message.text).toContain("Work record");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "the chat history a fresh session reads is this chat's, newest first, searchable and paged",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("history-thread");
        const other = ThreadId.make("other-thread");
        const insert = (id: string, threadId: ThreadId, role: string, text: string, at: string) =>
          sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${id}, ${threadId}, NULL, ${role}, ${text}, 0, ${at}, ${at})`;
        yield* insert(
          "m1",
          thread,
          "user",
          "Run the build with --prod",
          "2026-10-04T10:00:00.000Z",
        );
        yield* insert("m2", thread, "assistant", "Build ran: exit 0", "2026-10-04T10:01:00.000Z");
        yield* insert(
          "m3",
          thread,
          "user",
          "Now the long one " + "x".repeat(2_000),
          "2026-10-04T10:02:00.000Z",
        );
        yield* insert("m4", thread, "assistant", "Done.", "2026-10-04T10:03:00.000Z");
        yield* insert("x1", other, "user", "Secret of another chat", "2026-10-04T10:04:00.000Z");
        yield* insert("sys", thread, "system", "app note", "2026-10-04T10:05:00.000Z");

        const newest = yield* service.chatHistory({ threadId: thread, limit: 2 });
        expect(newest.messages.map((m) => m.messageId)).toEqual(["m4", "m3"]);
        expect(newest.hasMore).toBe(true);
        expect(newest.messages[1]!.clipped).toBe(true);
        expect(newest.messages[1]!.text.length).toBeLessThan(1_300);
        const older = yield* service.chatHistory({
          threadId: thread,
          limit: 5,
          beforeMessageId: "m3",
        });
        expect(older.messages.map((m) => m.messageId)).toEqual(["m2", "m1"]);
        expect(older.hasMore).toBe(false);
        const found = yield* service.chatHistory({ threadId: thread, limit: 5, query: "BUILD" });
        expect(found.messages.map((m) => m.messageId)).toEqual(["m2", "m1"]);
        // Another chat is never read, and a query that matches nothing is empty.
        expect(
          (yield* service.chatHistory({ threadId: thread, limit: 20, query: "another chat" }))
            .messages,
        ).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );
});

// --- usage-limit model fallback ---------------------------------------------------

const fallbackProviders = (claudeUsedPercent: number) => [
  { instanceId: "codex", driver: "codex", enabled: true, installed: true, status: "ready" },
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    usageLimits: {
      checkedAt: "2026-10-06T15:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "5 hours",
          usedPercent: claudeUsedPercent,
          resetsAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
  },
];

it.effect(
  "a Codex limit on a task moves its bot to the fallback model and the task runs again at once",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const root = yield* createRoot("fb-run", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const now = yield* DateTime.now;
      const limit = providerWait("rate_limited", now, 6 * 60 * 60_000);
      const startsBefore = turnStarts(harness).length;
      yield* waitOnProvider(harness, thread, turnId, { ...limit, provider: "codex" });

      // The bot is on the fallback and the task is not parked for six hours.
      const bot = Option.getOrThrow(yield* bots.getBotById({ botId: botId("developer") }));
      expect(bot.modelSelection.instanceId).toBe("codex");
      expect(bot.fallbackActive?.modelSelection.model).toBe("claude-sonnet-5-5");
      expect(
        harness.dispatched.some(
          (command) =>
            command.type === "thread.message.assistant.delta" &&
            command.delta.startsWith("Codex hit its usage limit. Developer is on Sonnet 5.5"),
        ),
      ).toBe(true);

      // The next dispatcher pass runs the task again, on the fallback model.
      const service = yield* PersonalTaskService.PersonalTaskService;
      yield* service.sweep;
      yield* service.drain;
      const resumed = turnStarts(harness).slice(startsBefore).at(-1);
      expect(resumed?.modelSelection).toMatchObject({
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
      });
      expect((yield* reload(root.taskId)).status).toBe("running");
    }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(10))));
  },
);

it.effect(
  "a Codex limit on a task still waits for the reset when the fallback provider is limited",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const root = yield* createRoot("fb-wait", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const now = yield* DateTime.now;
      const limit = providerWait("rate_limited", now, 6 * 60 * 60_000);
      yield* waitOnProvider(harness, thread, turnId, { ...limit, provider: "codex" });
      const bot = Option.getOrThrow(yield* bots.getBotById({ botId: botId("developer") }));
      expect(bot.fallbackActive).toBeUndefined();
      const paused = yield* reload(root.taskId);
      expect([paused.status, paused.errorCategory]).toEqual(["rate_limited", "rate_limited"]);
      expect(DateTime.toEpochMillis(paused.availableAt!)).toBe(Date.parse(limit.retryAt!));
    }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(100))));
  },
);

// The order Codex reports a usage limit in: the error first (the session errors with the
// turn still open and no details), then the turn's completion carrying the reset time.
const CODEX_LIMIT_ERROR = "Codex usage limit reached. Try again later.";

const codexLimitInOrder = (harness: Harness, threadId: ThreadId, turnId: TurnId, waitMs: number) =>
  Effect.gen(function* () {
    const first = yield* DateTime.now;
    yield* setSession(
      harness,
      makeSession({
        threadId,
        status: "error",
        activeTurnId: turnId,
        lastError: CODEX_LIMIT_ERROR,
        updatedAt: DateTime.formatIso(first),
      }),
    );
    const second = yield* DateTime.now;
    const retry = { ...providerWait("rate_limited", second, waitMs), provider: "codex" };
    yield* setSession(
      harness,
      makeSession({
        threadId,
        status: "error",
        activeTurnId: null,
        lastError: CODEX_LIMIT_ERROR,
        providerRetry: retry,
        updatedAt: DateTime.formatIso(second),
      }),
    );
    return retry;
  });

it.effect(
  "a task whose Codex limit arrives as an error and then a completed turn moves to the fallback",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("fb-order", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const startsBefore = turnStarts(harness).length;

      // The error alone does not end the attempt: its limit details are still coming.
      const first = yield* DateTime.now;
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "error",
          activeTurnId: turnId,
          lastError: CODEX_LIMIT_ERROR,
          updatedAt: DateTime.formatIso(first),
        }),
      );
      expect((yield* reload(root.taskId)).status).toBe("running");
      const before = Option.getOrThrow(yield* bots.getBotById({ botId: botId("developer") }));
      expect(before.fallbackActive).toBeUndefined();

      const second = yield* DateTime.now;
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "error",
          activeTurnId: null,
          lastError: CODEX_LIMIT_ERROR,
          providerRetry: {
            ...providerWait("rate_limited", second, 6 * 60 * 60_000),
            provider: "codex",
          },
          updatedAt: DateTime.formatIso(second),
        }),
      );
      const bot = Option.getOrThrow(yield* bots.getBotById({ botId: botId("developer") }));
      expect(bot.fallbackActive?.modelSelection.model).toBe("claude-sonnet-5-5");

      yield* service.sweep;
      yield* service.drain;
      const resumed = turnStarts(harness).slice(startsBefore);
      expect(resumed.length).toBe(1);
      expect(resumed[0]?.modelSelection).toMatchObject({
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
      });
      expect((yield* reload(root.taskId)).status).toBe("running");
    }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(10))));
  },
);

it.effect(
  "a task whose Codex limit arrives in that order waits for the reported reset when no fallback applies",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("fb-order-wait", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const retry = yield* codexLimitInOrder(harness, thread, turnId, 3 * 60 * 60_000);
      const paused = yield* reload(root.taskId);
      expect([paused.status, paused.errorCategory]).toEqual(["rate_limited", "rate_limited"]);
      // The reported reset, not the one minute backoff of an unreported limit.
      expect(DateTime.toEpochMillis(paused.availableAt!)).toBe(Date.parse(retry.retryAt!));
    }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(100))));
  },
);

it.effect(
  "a limit error that never gets its completion settles after the wait on the unreported backoff",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("fb-order-lost", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const first = yield* DateTime.now;
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "error",
          activeTurnId: turnId,
          lastError: CODEX_LIMIT_ERROR,
          updatedAt: DateTime.formatIso(first),
        }),
      );
      yield* TestClock.adjust("5 seconds");
      yield* service.sweep;
      yield* service.drain;
      expect((yield* reload(root.taskId)).status).toBe("running");
      yield* TestClock.adjust("6 seconds");
      yield* service.sweep;
      yield* service.drain;
      const settled = yield* reload(root.taskId);
      expect([settled.status, settled.errorCategory]).toEqual(["rate_limited", "rate_limited"]);
    }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(100))));
  },
);

it.effect("an error that does not read like a limit still settles at once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const root = yield* createRoot("fb-order-plain", "developer");
    const thread = threadOf(root);
    const turnId = yield* beginTurn(harness, thread);
    const now = yield* DateTime.now;
    yield* setSession(
      harness,
      makeSession({
        threadId: thread,
        status: "error",
        activeTurnId: turnId,
        lastError: "The model crashed.",
        updatedAt: DateTime.formatIso(now),
      }),
    );
    expect((yield* reload(root.taskId)).status).toBe("failed");
  }).pipe(Effect.provide(makeLayer(harness)));
});

/** The user message the dispatcher posted for an attempt: what makes a session state fresh for it. */
const postAttemptMessage = (
  harness: Harness,
  taskId: PersonalTask["taskId"],
  threadId: ThreadId,
  attempt: number,
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    harness.messages.set(threadId, [
      ...(harness.messages.get(threadId) ?? []),
      {
        messageId: MessageId.make(`personal-task-${taskId}-${attempt}`),
        threadId,
        turnId: null,
        role: "user",
        text: `Retry, attempt ${attempt}.`,
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

it.effect(
  "the old provider session's late error or stop does not end the attempt running on the fallback",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("fb-late-old", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const startsBefore = turnStarts(harness).length;
      yield* TestClock.adjust("5 seconds");
      const reported = DateTime.subtract(yield* DateTime.now, { seconds: 1 });
      yield* waitOnProvider(harness, thread, turnId, {
        ...providerWait("rate_limited", reported, 6 * 60 * 60_000),
        provider: "codex",
      });
      yield* TestClock.adjust("2 seconds");
      yield* service.sweep;
      yield* service.drain;
      expect(turnStarts(harness).length - startsBefore).toBe(1);
      expect((yield* reload(root.taskId)).status).toBe("running");
      yield* postAttemptMessage(harness, root.taskId, thread, 2);

      // The home session (codex) reports its end while the fallback attempt is starting.
      const late = DateTime.formatIso(yield* DateTime.now);
      for (const status of ["error", "stopped"] as const) {
        yield* setSession(
          harness,
          makeSession({
            threadId: thread,
            status,
            activeTurnId: null,
            lastError: CODEX_LIMIT_ERROR,
            providerInstanceId: "codex",
            updatedAt: late,
          }),
        );
        expect((yield* reload(root.taskId)).status).toBe("running");
      }

      // The fallback's own turn runs and its reply is the result.
      const second = TurnId.make("turn-fallback-late");
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "running",
          activeTurnId: second,
          providerInstanceId: "claudeAgent",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );
      yield* endTurn(harness, thread, second, "Finished on the fallback.");
      const done = yield* reload(root.taskId);
      expect([done.status, done.result?.summary]).toEqual([
        "completed",
        "Finished on the fallback.",
      ]);
      expect(turnStarts(harness).length - startsBefore).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(10))));
  },
);

it.effect("an error from the fallback's own session still ends the attempt running on it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("fb-own-error", "developer");
    const thread = threadOf(root);
    const turnId = yield* beginTurn(harness, thread);
    yield* TestClock.adjust("5 seconds");
    const reported = DateTime.subtract(yield* DateTime.now, { seconds: 1 });
    yield* waitOnProvider(harness, thread, turnId, {
      ...providerWait("rate_limited", reported, 6 * 60 * 60_000),
      provider: "codex",
    });
    yield* TestClock.adjust("2 seconds");
    yield* service.sweep;
    yield* service.drain;
    expect((yield* reload(root.taskId)).status).toBe("running");
    yield* postAttemptMessage(harness, root.taskId, thread, 2);
    yield* setSession(
      harness,
      makeSession({
        threadId: thread,
        status: "error",
        activeTurnId: null,
        lastError: "The model crashed.",
        providerInstanceId: "claudeAgent",
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    expect((yield* reload(root.taskId)).status).toBe("failed");
  }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(10))));
});

it.effect(
  "the task that triggers the switch runs once on the fallback: the old wait does not end its retry",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("fb-once", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      // Reported while attempt 1's turn was waiting, a moment before the switch.
      yield* TestClock.adjust("5 seconds");
      const reported = DateTime.subtract(yield* DateTime.now, { seconds: 1 });
      const stale = {
        ...providerWait("rate_limited", reported, 6 * 60 * 60_000),
        provider: "codex",
      };
      const startsBefore = turnStarts(harness).length;
      yield* waitOnProvider(harness, thread, turnId, stale);

      // The switch released the task: attempt 2 starts on the fallback.
      yield* TestClock.adjust("2 seconds");
      yield* service.sweep;
      yield* service.drain;
      expect(turnStarts(harness).length - startsBefore).toBe(1);
      expect((yield* reload(root.taskId)).status).toBe("running");

      // Attempt 2's turn starts while the thread's session still shows attempt 1's wait.
      // That wait does not belong to attempt 2.
      const second = TurnId.make("turn-fallback");
      yield* waitOnProvider(harness, thread, second, stale);
      expect((yield* reload(root.taskId)).status).toBe("running");
      expect(interrupts(harness).length).toBe(1);

      // Its own turn finishes on the fallback and its reply is the task's result.
      yield* endTurn(harness, thread, second, "Done on the fallback.");
      const done = yield* reload(root.taskId);
      expect(done.status).toBe("completed");
      expect(done.result?.summary).toBe("Done on the fallback.");
      expect(turnStarts(harness).length - startsBefore).toBe(1);
      const detail = yield* service.get({ taskId: root.taskId });
      expect(detail.attempts.map((attempt) => attempt.errorCategory)).toEqual([
        "rate_limited",
        null,
      ]);
    }).pipe(Effect.provide(makeLayer(harness, undefined, undefined, fallbackProviders(10))));
  },
);

// --- handing work into a chat the owner already talks in (1.66.12) ----------------

describe("a delegated task continuing the owner's chat (1.66.12)", () => {
  const CHAT = "chat-owner-talk" as ThreadId;

  /** A chat between the owner and `bot`: linked, projected, with an earlier exchange in it. */
  const seedOwnerChat = (
    harness: Harness,
    threadId: ThreadId,
    title: string,
    bot: BotKey = "developer",
  ) =>
    Effect.gen(function* () {
      const bots = yield* PersonalBotService.PersonalBotService;
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* bots.createThread({ botId: botId(bot), threadId, title });
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${threadId}, 'project', ${title}, ${now}, ${now})
      `;
      harness.titles.set(threadId, title);
      yield* setSession(
        harness,
        makeSession({ threadId, status: "ready", activeTurnId: null, updatedAt: now }),
      );
    });

  /** A root request of the assistant whose turn is open, so it can delegate. */
  const leadRequest = (harness: Harness, key: string) =>
    Effect.gen(function* () {
      const root = yield* createRoot(key);
      const rootThread = threadOf(root);
      const turnId = yield* beginTurn(harness, rootThread);
      return { root, rootThread, turnId };
    });

  const continueInto = (parent: PersonalTask, chat: ThreadId, bot: BotKey = "developer") =>
    Effect.gen(function* () {
      const service = yield* PersonalTaskService.PersonalTaskService;
      return yield* service.delegate({
        parentTaskId: parent.taskId,
        targetBotId: botId(bot),
        brief: brief("Implement the review"),
        continueThreadId: chat,
      });
    });

  it.effect(
    "runs as a new turn in that chat, shown as the lead's brief, and the result goes back to the lead",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        yield* seedOwnerChat(harness, CHAT, "Memory article review");
        yield* TestClock.adjust("1 minute");
        const { root, rootThread, turnId } = yield* leadRequest(harness, "continue-1");
        const createsBefore = threadCreates(harness).length;

        const child = yield* continueInto(root, CHAT);
        yield* endTurn(harness, rootThread, turnId, "Handed to Developer.");
        yield* service.drain;

        const running = yield* reload(child.taskId);
        expect(running.status).toBe("running");
        expect(running.threadId).toBe(CHAT);
        expect(running.source).toBe("delegation");
        const starts = startsOn(harness, CHAT);
        expect(starts).toHaveLength(1);
        // The brief is the lead's, not the owner's: a task message id and marker.
        expect(starts[0]!.message.messageId.startsWith("personal-task-")).toBe(true);
        expect(starts[0]!.message.text).toContain("[Delegated task from Assistant]");
        expect(starts[0]!.message.text).toContain("Implement the review objective");
        const marker = starts[0]!.message.context as unknown as {
          readonly records: ReadonlyArray<{
            readonly payload: { readonly source: string; readonly delegatorBotId: string | null };
          }>;
        };
        expect(marker.records[0]!.payload).toMatchObject({
          source: "delegation",
          delegatorBotId: botId("assistant"),
        });
        // No second chat is made, and the chat keeps its name.
        expect(threadCreates(harness).length).toBe(createsBefore);
        expect(
          harness.dispatched.some(
            (command) =>
              (command.type === "thread.meta.update" ||
                command.type === "thread.title.generate.complete") &&
              command.threadId === CHAT,
          ),
        ).toBe(false);

        yield* runTurn(harness, CHAT, "The word from our talk was kiwi.");
        yield* service.drain;
        const done = yield* reload(child.taskId);
        expect(done.status).toBe("completed");
        expect(done.result?.summary).toBe("The word from our talk was kiwi.");
        // The lead is woken in its own chat with the result.
        const wake = startsOn(harness, rootThread).at(-1)!;
        expect(wake.message.text).toContain("The word from our talk was kiwi.");
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("waits while a turn runs in the chat, then starts when it is idle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      yield* seedOwnerChat(harness, CHAT, "Memory article review");
      yield* TestClock.adjust("1 minute");
      const { root } = yield* leadRequest(harness, "continue-busy");
      const ownerTurn = yield* beginTurn(harness, CHAT);

      const child = yield* continueInto(root, CHAT);
      yield* service.drain;
      expect((yield* reload(child.taskId)).status).toBe("queued");
      expect(startsOn(harness, CHAT)).toHaveLength(0);

      yield* endTurn(harness, CHAT, ownerTurn, "Owner's own turn.");
      yield* service.drain;
      expect((yield* reload(child.taskId)).status).toBe("running");
      expect(startsOn(harness, CHAT)).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("an archived chat is continued like any chat: the new turn goes into it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const bots = yield* PersonalBotService.PersonalBotService;
      yield* seedOwnerChat(harness, CHAT, "Old review");
      yield* TestClock.adjust("1 minute");
      yield* bots.archiveThread({ threadId: CHAT, archived: true });
      const { root } = yield* leadRequest(harness, "continue-archived");

      const child = yield* continueInto(root, CHAT);
      yield* service.drain;

      expect((yield* reload(child.taskId)).threadId).toBe(CHAT);
      expect(startsOn(harness, CHAT)).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "refuses a chat that is not a plain conversation of that bot, with a clear reason",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const sql = yield* SqlClient.SqlClient;
        const { root } = yield* leadRequest(harness, "continue-refused");
        const refusal = (chat: ThreadId, bot: BotKey = "developer") =>
          continueInto(root, chat, bot).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );

        expect(yield* refusal("no-such-chat" as ThreadId)).toContain("There is no chat");

        // Another bot's chat.
        yield* seedOwnerChat(harness, "chat-researcher" as ThreadId, "Research", "researcher");
        expect(yield* refusal("chat-researcher" as ThreadId)).toContain(
          "not a chat of the bot you are delegating to",
        );

        // A deleted chat.
        yield* seedOwnerChat(harness, "chat-deleted" as ThreadId, "Gone");
        yield* sql`UPDATE projection_threads SET deleted_at = ${"2026-10-01T00:00:00.000Z"} WHERE thread_id = 'chat-deleted'`;
        expect(yield* refusal("chat-deleted" as ThreadId)).toContain("was deleted");

        // A group member's relay thread.
        yield* seedOwnerChat(harness, "chat-relay" as ThreadId, "In a group");
        yield* sql`
        INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
        VALUES ('g-1', 'Team', 'g-thread', 8, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO personal_group_members (group_id, bot_id, thread_id, role, sort_order, joined_at)
        VALUES ('g-1', ${botId("developer")}, 'chat-relay', 'member', 0, '2026-09-25T00:00:00.000Z')
      `;
        expect(yield* refusal("chat-relay" as ThreadId)).toContain("group conversation");

        // A chat made for another delegated task.
        const other = yield* service.delegate({
          parentTaskId: root.taskId,
          targetBotId: botId("developer"),
          brief: brief("Some other job"),
        });
        yield* service.drain;
        const taskChat = threadOf(yield* reload(other.taskId));
        yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${taskChat}, 'project', 'Some other job', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `;
        expect(yield* refusal(taskChat)).toContain("made for a delegated task");

        // A routine's chat.
        yield* seedOwnerChat(harness, "chat-routine" as ThreadId, "Daily digest");
        yield* sql`
        INSERT INTO personal_routines
          (routine_id, bot_id, title, prompt, schedule_json, created_at, updated_at, thread_id)
        VALUES ('r-1', ${botId("developer")}, 'Daily digest', 'Digest.', '{}',
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'chat-routine')
      `;
        expect(yield* refusal("chat-routine" as ThreadId)).toContain("where a routine posts");

        // Nothing was queued by any refusal.
        const tasksNow = (yield* service.list({})).tasks;
        expect(tasksNow.filter((task) => task.title === "Implement the review")).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "the chat stays an ordinary chat: not an auto-archive candidate, not a task chat, still listed",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const repository = yield* PersonalBotRepository.PersonalBotRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* seedOwnerChat(harness, CHAT, "Memory article review");
        yield* TestClock.adjust("1 minute");
        const { root, rootThread, turnId } = yield* leadRequest(harness, "continue-ordinary");

        // A control: an ordinary delegated task with a chat of its own.
        const control = yield* service.delegate({
          parentTaskId: root.taskId,
          targetBotId: botId("researcher"),
          brief: brief("Control job"),
        });
        const child = yield* continueInto(root, CHAT);
        yield* endTurn(harness, rootThread, turnId, "Handed over.");
        yield* service.drain;
        const controlChat = threadOf(yield* reload(control.taskId));
        yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES (${controlChat}, 'project', 'Control job', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
        `;
        yield* runTurn(harness, CHAT, "Done in the chat.");
        yield* runTurn(harness, controlChat, "Done in its own chat.");
        yield* service.drain;
        expect((yield* reload(child.taskId)).status).toBe("completed");
        expect((yield* reload(control.taskId)).status).toBe("completed");

        const candidates = yield* sql.unsafe<{ readonly threadId: string }>(
          TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL,
        );
        const candidateIds = candidates.map((row) => row.threadId);
        expect(candidateIds).toContain(controlChat);
        expect(candidateIds).not.toContain(CHAT);

        const open = yield* repository.listOpenChats({ botId: botId("developer") });
        expect(open.find((chat) => chat.threadId === CHAT)?.taskChat).toBe(false);
        const direct = yield* repository.listDirectChats({ botId: botId("developer"), limit: 10 });
        expect(direct.map((chat) => chat.threadId)).toEqual([CHAT]);
        const researcher = yield* repository.listDirectChats({
          botId: botId("researcher"),
          limit: 10,
        });
        expect(researcher.map((chat) => chat.threadId)).toEqual([]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "steer_task reopens it in the same chat and keeps the conversation instead of a fresh session",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        yield* seedOwnerChat(harness, CHAT, "Memory article review");
        yield* TestClock.adjust("1 minute");
        const { root, rootThread, turnId } = yield* leadRequest(harness, "continue-reopen");
        const child = yield* continueInto(root, CHAT);
        yield* endTurn(harness, rootThread, turnId, "Handed over.");
        yield* service.drain;
        yield* service.updateWorkRecord({
          taskId: child.taskId,
          patch: { decisions: ["Keep the cache."], nextStep: "Second half" },
        });
        yield* runTurn(harness, CHAT, "Half done.");
        yield* service.drain;
        yield* runTurn(harness, rootThread, "Reported.");
        yield* service.drain;
        // A long chat: a task in its own chat would start a fresh session here.
        yield* reportContextTokens(CHAT, 120_000);
        const startsBefore = startsOn(harness, CHAT).length;

        const steered = yield* service.steer({
          taskId: child.taskId,
          fromName: "Assistant",
          message: "Now do the second half.",
        });
        yield* service.drain;

        expect(steered.outcome).toBe("reopened");
        const starts = startsOn(harness, CHAT);
        expect(starts).toHaveLength(startsBefore + 1);
        const continuation = starts.at(-1)!;
        expect(continuation.message.text).toContain(
          "Update from Assistant: Now do the second half.",
        );
        expect(continuation.message.text).not.toContain(PersonalTaskService.FRESH_SESSION_NOTE);
        expect(continuation.message.text).not.toContain("Work record");
        expect(markerOf(continuation).fresh).toBeUndefined();
        expect((yield* reload(child.taskId)).threadId).toBe(CHAT);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("carries the sensitive-site marks both ways", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const sql = yield* SqlClient.SqlClient;
      const exposures = makeSensitiveExposureStore(sql);
      yield* seedOwnerChat(harness, CHAT, "Bank questions");
      yield* seedOwnerChat(harness, "chat-clean" as ThreadId, "Clean chat");
      yield* TestClock.adjust("1 minute");
      const { root } = yield* leadRequest(harness, "continue-exposure");

      // The delegating tree saw a sensitive site: the chat takes the mark.
      yield* exposures.record([rootExposureKey(root.rootTaskId)], "source", "https://bank.example");
      yield* continueInto(root, CHAT);
      expect([...(yield* exposures.read([threadExposureKey(CHAT)])).sources]).toEqual([
        "https://bank.example",
      ]);

      // The chat had seen a different one: the tree takes that too, so nothing of it is kept.
      const second = yield* createRoot("continue-exposure-2");
      yield* exposures.record([threadExposureKey("chat-clean")], "source", "https://mail.example");
      const fromMail = yield* continueInto(second, "chat-clean" as ThreadId);
      expect([...(yield* exposures.read([rootExposureKey(fromMail.rootTaskId)])).sources]).toEqual([
        "https://mail.example",
      ]);
      const refused = yield* Effect.flip(
        service.updateWorkRecord({ taskId: fromMail.taskId, patch: { nextStep: "x" } }),
      );
      expect(refused.message).toContain("sensitive");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "a mark that arrives by a steer stays with the chat: a later delegation into it from a clean request keeps it",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const sql = yield* SqlClient.SqlClient;
        const exposures = makeSensitiveExposureStore(sql);
        yield* seedOwnerChat(harness, CHAT, "Clean chat");
        yield* TestClock.adjust("1 minute");

        // 1. Delegate into a clean chat and let the task finish.
        const { root, rootThread, turnId } = yield* leadRequest(harness, "steer-persist");
        const first = yield* continueInto(root, CHAT);
        yield* endTurn(harness, rootThread, turnId, "Handed over.");
        yield* service.drain;
        yield* runTurn(harness, CHAT, "Half done.");
        yield* service.drain;
        yield* runTurn(harness, rootThread, "Reported.");
        yield* service.drain;
        expect([...(yield* exposures.read([threadExposureKey(CHAT)])).sources]).toEqual([]);

        // 2. A chat that opened a sensitive site steers it: the update reaches the chat.
        const steerer = yield* createRoot("steer-persist-steerer");
        yield* exposures.record(
          [threadExposureKey(threadOf(steerer))],
          "source",
          "https://bank.example",
        );
        yield* exposures.record(
          [threadExposureKey(threadOf(steerer))],
          "approved",
          "https://ok.example",
        );
        const steered = yield* service.steer({
          taskId: first.taskId,
          fromName: "CTO",
          message: "The balance is 1,234, carry on.",
          fromThreadId: threadOf(steerer),
        });
        expect(steered.outcome).toBe("reopened");
        // The chat itself carries the mark (not the approval), not only the old tree.
        const onChat = yield* exposures.read([threadExposureKey(CHAT)]);
        expect([...onChat.sources]).toEqual(["https://bank.example"]);
        expect([...onChat.approved]).toEqual([]);
        yield* service.drain;
        yield* runTurn(harness, CHAT, "Second half done.");
        yield* service.drain;

        // 3. A clean request delegates into the same chat: its tree starts with the mark.
        const clean = yield* createRoot("steer-persist-clean");
        expect([...(yield* exposures.read([rootExposureKey(clean.rootTaskId)])).sources]).toEqual(
          [],
        );
        const second = yield* continueInto(clean, CHAT);
        const carried = yield* exposures.read([rootExposureKey(second.rootTaskId)]);
        expect([...carried.sources]).toEqual(["https://bank.example"]);
        expect([...carried.approved]).toEqual([]);
        const refused = yield* Effect.flip(
          service.updateWorkRecord({ taskId: second.taskId, patch: { nextStep: "x" } }),
        );
        expect(refused.message).toContain("sensitive");
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "a mark that reaches the tree after the delegation is put on the chat before its next turn starts",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const sql = yield* SqlClient.SqlClient;
        const exposures = makeSensitiveExposureStore(sql);
        yield* seedOwnerChat(harness, CHAT, "Clean chat");
        yield* TestClock.adjust("1 minute");
        const { root, rootThread, turnId } = yield* leadRequest(harness, "claim-persist");
        yield* continueInto(root, CHAT);
        // A sibling of the task browsed a sensitive site after the delegation was made.
        yield* exposures.record(
          [rootExposureKey(root.rootTaskId)],
          "source",
          "https://bank.example",
        );
        expect([...(yield* exposures.read([threadExposureKey(CHAT)])).sources]).toEqual([]);

        yield* endTurn(harness, rootThread, turnId, "Handed over.");
        yield* service.drain;

        expect(startsOn(harness, CHAT)).toHaveLength(1);
        expect([...(yield* exposures.read([threadExposureKey(CHAT)])).sources]).toEqual([
          "https://bank.example",
        ]);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect(
    "a mark that cannot be written keeps the update back, and the task off the chat",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* seedBots;
        const service = yield* PersonalTaskService.PersonalTaskService;
        const sql = yield* SqlClient.SqlClient;
        const exposures = makeSensitiveExposureStore(sql);
        yield* seedOwnerChat(harness, CHAT, "Clean chat");
        yield* TestClock.adjust("1 minute");
        const { root, rootThread, turnId } = yield* leadRequest(harness, "persist-closed");
        const first = yield* continueInto(root, CHAT);
        yield* endTurn(harness, rootThread, turnId, "Handed over.");
        yield* service.drain;
        yield* runTurn(harness, CHAT, "Half done.");
        yield* service.drain;
        yield* runTurn(harness, rootThread, "Reported.");
        yield* service.drain;
        const steerer = yield* createRoot("persist-closed-steerer");
        yield* exposures.record(
          [threadExposureKey(threadOf(steerer))],
          "source",
          "https://bank.example",
        );
        // Only writes to the chat's own key fail; the tree's key is fine.
        yield* sql.unsafe(`
        CREATE TRIGGER fail_chat_mark BEFORE INSERT ON personal_sensitive_exposures
        WHEN NEW.exposure_key = '${threadExposureKey(CHAT)}'
        BEGIN SELECT RAISE(ABORT, 'no chat marks'); END
      `);
        const startsBefore = startsOn(harness, CHAT).length;
        const refused = yield* Effect.flip(
          service.steer({
            taskId: first.taskId,
            fromName: "CTO",
            message: "The balance is 1,234, carry on.",
            fromThreadId: threadOf(steerer),
          }),
        );
        expect(refused.message).toContain("update was not sent");
        yield* service.drain;
        expect(startsOn(harness, CHAT)).toHaveLength(startsBefore);
        expect((yield* reload(first.taskId)).status).toBe("completed");
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );
});
