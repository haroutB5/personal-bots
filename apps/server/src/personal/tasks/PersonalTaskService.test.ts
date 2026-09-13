import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  PersonalBotId,
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
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
  readonly updatedAt: string;
}): OrchestrationSession => ({
  threadId: input.threadId,
  status: input.status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: input.activeTurnId,
  lastError: input.lastError ?? null,
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
  end: { readonly status?: OrchestrationSession["status"]; readonly lastError?: string } = {},
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
        updatedAt: now,
      }),
    );
  });

const runTurn = (
  harness: Harness,
  threadId: ThreadId,
  reply: string,
  end: { readonly status?: OrchestrationSession["status"]; readonly lastError?: string } = {},
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

it.effect("a waiting parent releases its slot so both children run under concurrency 2", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalTaskService.PersonalTaskService;
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

    // Root's turn is still running: it and the first child fill both slots.
    expect((yield* reload(first.taskId)).status).toBe("running");
    expect((yield* reload(second.taskId)).status).toBe("queued");
    expect(turnStarts(harness).length).toBe(2);

    // Root's turn ends while children are open: it waits and frees its slot.
    yield* endTurn(harness, rootThread, rootTurn, "Delegated.");
    const waitingRoot = yield* reload(root.taskId);
    expect(waitingRoot.status).toBe("waiting_for_agent");
    const firstRunning = yield* reload(first.taskId);
    const secondRunning = yield* reload(second.taskId);
    expect([firstRunning.status, secondRunning.status]).toEqual(["running", "running"]);
    expect(turnStarts(harness).length).toBe(3);
    expect(turnStarts(harness)[2]!.message.text).toContain("[Delegated task from Assistant]");

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
  }).pipe(Effect.provide(makeLayer(harness)));
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
