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
  type ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
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
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import * as PersonalTaskService from "./PersonalTaskService.ts";

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
  sequence: 0,
});

/** `dbPath` rebuilds the service over a file database, simulating a restart. */
const makeLayer = (harness: Harness, dbPath?: string) =>
  PersonalTaskService.layer.pipe(
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
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() => {
            const session = harness.sessions.get(threadId);
            return session === undefined ? Option.none() : Option.some({ id: threadId, session });
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
  readonly updatedAt: string;
}): OrchestrationSession => ({
  threadId: input.threadId,
  status: input.status,
  providerName: "codex",
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

    yield* runTurn(harness, threadOf(firstRunning), "Built.");
    expect((yield* reload(first.taskId)).status).toBe("completed");
    expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");

    yield* runTurn(harness, threadOf(secondRunning), "Researched.");
    const continued = yield* reload(root.taskId);
    expect(continued.status).toBe("running");
    const continuation = turnStarts(harness).at(-1)!;
    expect(continuation.threadId).toBe(rootThread);
    expect(continuation.message.text).toContain("[Task continuation]");
    expect(continuation.message.text).toContain("Built.");
    expect(continuation.message.text).toContain("Researched.");

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

it.effect("steer refuses a finished task", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
    const root = yield* createRoot("steer-finished");
    yield* runTurn(harness, threadOf(root), "Done.");
    const before = turnStarts(harness).length;

    const error = yield* service
      .steer({ taskId: root.taskId, fromName: "CTO", message: "One more thing." })
      .pipe(Effect.flip);

    expect(error.message).toContain("already completed");
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
