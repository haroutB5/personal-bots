// @effect-diagnostics preferSchemaOverJson:off - builds provider activity rows
// Provider-boundary scenarios for delegated tasks, at the point where the provider's state reaches the task
// service: the projected session and messages. A scripted fake provider (the `codex`, `claude` and `provider`
// helpers below) writes them in the shapes and orders the adapters produce, including duplicates, late and
// out-of-order events, a crash and a restart. The same stand-ins as PersonalTaskService.test.ts: commands are
// recorded, the session and messages are set by the test, no timers (TestClock). taskProviderChain.test.ts runs
// the same kind of scenarios through the real ingestion and engine.
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
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
import * as PersonalTaskService from "./PersonalTaskService.ts";

// --- stand-ins for the orchestration side (same as PersonalTaskService.test.ts) -------

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

const optionOf = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value);

const compareNewestFirst = (
  left: { readonly createdAt: string; readonly messageId: string },
  right: { readonly createdAt: string; readonly messageId: string },
) => right.createdAt.localeCompare(left.createdAt) || right.messageId.localeCompare(left.messageId);

/** `dbPath` rebuilds the service over a file database, simulating a restart. */
const makeLayer = (
  harness: Harness,
  dbPath?: string,
  fallbackProviders?: ReadonlyArray<unknown>,
  /** Server environment the services read through Config (kill switches). */
  env: Record<string, string> = {},
) =>
  PersonalTaskService.layer.pipe(
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Layer.provideMerge(fallbackProviders === undefined ? Layer.empty : PersonalModelFallback.layer),
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
          afterMessageId,
        }: {
          readonly threadId: ThreadId;
          readonly afterCreatedAt: string;
          readonly afterMessageId: MessageId;
        }) =>
          Effect.sync(() => {
            const list = harness.messages.get(threadId) ?? [];
            const anchor = list.findIndex((message) => message.messageId === afterMessageId);
            return optionOf(
              list.slice(anchor + 1).findLast((message) => message.role === "assistant"),
            );
          }),
      } as unknown as ProjectionThreadMessageRepositoryShape),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-tasks-boundary-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const BOTS = ["assistant", "developer", "researcher"] as const;
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
const startsOn = (harness: Harness, threadId: ThreadId) =>
  turnStarts(harness).filter((command) => command.threadId === threadId);
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

/** The domain event the dispatcher is fed for a session; `suffix` makes a replay carry a fresh event id. */
const sessionEvent = (
  harness: Harness,
  session: OrchestrationSession,
  suffix = "",
): OrchestrationEvent => {
  harness.sequence += 1;
  const id = `evt-${harness.sequence}${suffix}`;
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

/** The projection moves to `session` and the dispatcher is told. */
const setSession = (harness: Harness, session: OrchestrationSession) =>
  Effect.gen(function* () {
    const service = yield* PersonalTaskService.PersonalTaskService;
    harness.sessions.set(session.threadId, session);
    yield* service.ingestDomainEvent(sessionEvent(harness, session));
    yield* service.drain;
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const beginTurn = (harness: Harness, threadId: ThreadId, label = "") =>
  Effect.gen(function* () {
    const turnId = TurnId.make(`turn-${threadId}-${harness.sequence + 1}${label}`);
    yield* setSession(
      harness,
      makeSession({ threadId, status: "running", activeTurnId: turnId, updatedAt: yield* nowIso }),
    );
    return turnId;
  });

/** The assistant's reply is projected (the message row), with no session change. */
const writeReply = (
  harness: Harness,
  threadId: ThreadId,
  turnId: TurnId,
  text: string,
  streaming = false,
) =>
  Effect.gen(function* () {
    const at = yield* nowIso;
    harness.messages.set(threadId, [
      ...(harness.messages.get(threadId) ?? []),
      {
        messageId: MessageId.make(`msg-${turnId}-${(harness.messages.get(threadId) ?? []).length}`),
        threadId,
        turnId,
        role: "assistant",
        text,
        isStreaming: streaming,
        createdAt: at,
        updatedAt: at,
      },
    ]);
  });

const endTurn = (
  harness: Harness,
  threadId: ThreadId,
  turnId: TurnId,
  text: string,
  end: Partial<Pick<OrchestrationSession, "status" | "lastError" | "providerRetry">> = {},
) =>
  Effect.gen(function* () {
    yield* writeReply(harness, threadId, turnId, text);
    yield* setSession(
      harness,
      makeSession({
        threadId,
        status: end.status ?? "ready",
        activeTurnId: null,
        ...(end.lastError == null ? {} : { lastError: end.lastError }),
        ...(end.providerRetry === undefined ? {} : { providerRetry: end.providerRetry }),
        updatedAt: yield* nowIso,
      }),
    );
  });

const runTurn = (
  harness: Harness,
  threadId: ThreadId,
  text: string,
  end: Partial<Pick<OrchestrationSession, "status" | "lastError" | "providerRetry">> = {},
) =>
  Effect.gen(function* () {
    const turnId = yield* beginTurn(harness, threadId);
    yield* endTurn(harness, threadId, turnId, text, end);
  });

const reload = (taskId: PersonalTask["taskId"]) =>
  Effect.gen(function* () {
    const service = yield* PersonalTaskService.PersonalTaskService;
    return (yield* service.get({ taskId })).task;
  });

const threadOf = (task: PersonalTask) => {
  if (task.threadId === null) throw new Error(`task ${task.taskId} has no thread yet`);
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

const sweepNow = Effect.gen(function* () {
  const service = yield* PersonalTaskService.PersonalTaskService;
  yield* service.sweep;
  yield* service.drain;
});

// --- the scripted fake provider ------------------------------------------------------

const providerWait = (
  kind: "rate_limited" | "retrying",
  provider: string,
  now: DateTime.Utc,
  waitMs: number | null,
): NonNullable<OrchestrationSession["providerRetry"]> => ({
  kind,
  provider,
  observedAt: DateTime.formatIso(now),
  ...(waitMs === null
    ? {}
    : { retryAt: DateTime.formatIso(DateTime.add(now, { milliseconds: waitMs })) }),
  reason: kind === "rate_limited" ? "usageLimitExceeded" : "HTTP 502 api_error",
});

/** What each adapter reports to the app, as the projected session. */
const provider = {
  /** Codex: the limit arrives as an error first (turn still open, no details), then the failed completion with the reset. */
  codexLimit: (harness: Harness, threadId: ThreadId, turnId: TurnId, waitMs: number) =>
    Effect.gen(function* () {
      const error = "Codex usage limit reached. Try again later.";
      yield* setSession(
        harness,
        makeSession({
          threadId,
          status: "error",
          activeTurnId: turnId,
          lastError: error,
          providerInstanceId: "codex",
          updatedAt: yield* nowIso,
        }),
      );
      const second = yield* DateTime.now;
      const retry = providerWait("rate_limited", "codex", second, waitMs);
      yield* setSession(
        harness,
        makeSession({
          threadId,
          status: "error",
          activeTurnId: null,
          lastError: error,
          providerRetry: retry,
          providerInstanceId: "codex",
          updatedAt: DateTime.formatIso(second),
        }),
      );
      return retry;
    }),
  /** Claude: the SDK parks the running turn on the rejected window; the session stays running with the wait on it. */
  claudeParked: (harness: Harness, threadId: ThreadId, turnId: TurnId, waitMs: number) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const retry = providerWait("rate_limited", "claudeAgent", now, waitMs);
      yield* setSession(
        harness,
        makeSession({
          threadId,
          status: "running",
          activeTurnId: turnId,
          providerRetry: retry,
          updatedAt: DateTime.formatIso(now),
        }),
      );
      return retry;
    }),
  /** The adapter process exits (crash, kill, shutdown): the session stops with no completion. */
  exits: (harness: Harness, threadId: ThreadId, lastError?: string) =>
    Effect.gen(function* () {
      yield* setSession(
        harness,
        makeSession({
          threadId,
          status: "stopped",
          activeTurnId: null,
          ...(lastError === undefined ? {} : { lastError }),
          updatedAt: yield* nowIso,
        }),
      );
    }),
};

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

// --- 1. interruption mid-turn: crash, lease expiry, restart --------------------------

it.effect(
  "a server that died mid-turn: its task is interrupted once its lease expires, never re-run, and retry resumes it on the same thread",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-boundary-db-" });
      const dbPath = path.join(directory, "state.sqlite");
      const before = makeHarness();
      const { taskId, thread } = yield* Effect.gen(function* () {
        yield* seedBots;
        const root = yield* createRoot("crash");
        yield* beginTurn(before, threadOf(root));
        expect((yield* reload(root.taskId)).status).toBe("running");
        return { taskId: root.taskId, thread: threadOf(root) };
      }).pipe(Effect.provide(makeLayer(before, dbPath)));

      // A fresh server over the same database: another lease owner, nothing in memory.
      const after = makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* PersonalTaskService.PersonalTaskService;
        // The dead owner's lease (2 minutes) has not run out yet: the task is still its.
        yield* TestClock.adjust("1 minute");
        yield* sweepNow;
        expect((yield* reload(taskId)).status).toBe("running");

        yield* TestClock.adjust("2 minutes");
        yield* sweepNow;
        const interrupted = yield* reload(taskId);
        expect(interrupted.status).toBe("interrupted");
        expect(interrupted.errorMessage).toBe("The server stopped while this task was running.");
        // Interrupted, not re-queued: the turn it may have been half way through is not started again.
        expect(turnStarts(after)).toEqual([]);
        // More sweeps settle nothing new and start nothing.
        yield* TestClock.adjust("10 minutes");
        yield* sweepNow;
        yield* sweepNow;
        expect((yield* reload(taskId)).status).toBe("interrupted");
        expect(turnStarts(after)).toEqual([]);

        // retry is the only way back: attempt 2, the same thread, the retry brief.
        yield* service.retry({ taskId });
        yield* service.drain;
        const detail = yield* service.get({ taskId });
        expect(detail.task.status).toBe("running");
        expect(detail.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
        expect(detail.attempts[1]!.providerThreadId).toBe(thread);
        const starts = startsOn(after, thread);
        expect(starts.length).toBe(1);
        expect(starts[0]!.message.text).toContain("Retry, attempt 2.");
      }).pipe(Effect.provide(makeLayer(after, dbPath)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a live server keeps its own lease: sweeps for hours never interrupt its running task",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("own-lease");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      for (let sweep = 0; sweep < 6; sweep += 1) {
        yield* TestClock.adjust("30 minutes");
        yield* sweepNow;
        expect((yield* reload(root.taskId)).status).toBe("running");
      }
      yield* endTurn(harness, thread, turnId, "Still here. Done.");
      const done = yield* reload(root.taskId);
      expect([done.status, done.result?.summary]).toEqual(["completed", "Still here. Done."]);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "an adapter that crashes mid-turn leaves the task interrupted and resumable, not failed or re-run",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("adapter-crash");
      const thread = threadOf(root);
      yield* beginTurn(harness, thread);
      yield* provider.exits(harness, thread, "Codex process exited unexpectedly (code 1).");
      const task = yield* reload(root.taskId);
      expect(task.status).toBe("interrupted");
      expect(task.errorMessage).toBe("Codex process exited unexpectedly (code 1).");
      const startsAfterCrash = turnStarts(harness).length;
      yield* TestClock.adjust("10 minutes");
      yield* sweepNow;
      yield* sweepNow;
      expect((yield* reload(root.taskId)).status).toBe("interrupted");
      expect(turnStarts(harness).length).toBe(startsAfterCrash);

      yield* service.retry({ taskId: root.taskId });
      yield* service.drain;
      const detail = yield* service.get({ taskId: root.taskId });
      expect(detail.task.status).toBe("running");
      expect(detail.attempts[1]!.providerThreadId).toBe(thread);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "a turn the user stops is interrupted; the provider's late completion does not complete it",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("user-stop");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "interrupted",
          activeTurnId: null,
          updatedAt: yield* nowIso,
        }),
      );
      expect((yield* reload(root.taskId)).status).toBe("interrupted");
      // The adapter reports the turn it was told to stop as completed a moment later.
      yield* endTurn(harness, thread, turnId, "Partial work before the stop.");
      yield* sweepNow;
      const task = yield* reload(root.taskId);
      expect(task.status).toBe("interrupted");
      expect(turnStarts(harness).length).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

// --- 2. event ordering: duplicates, late and early events ----------------------------

it.effect(
  "provider events after a task finished change nothing: a late exit, error or running replay",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("late-after-done");
      const rootThread = threadOf(root);
      const rootTurn = yield* beginTurn(harness, rootThread);
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Fix it"),
      });
      yield* endTurn(harness, rootThread, rootTurn, "Waiting on Developer.");
      const childThread = threadOf(yield* reload(child.taskId));
      const childTurn = yield* beginTurn(harness, childThread);
      yield* endTurn(harness, childThread, childTurn, "Fixed.");
      expect((yield* reload(child.taskId)).status).toBe("completed");
      const rootStarts = startsOn(harness, rootThread).length;
      expect(rootStarts).toBe(2);

      // The adapter's process exits after the turn, reports an error on the way out, and a stale running snapshot replays.
      yield* provider.exits(harness, childThread);
      yield* setSession(
        harness,
        makeSession({
          threadId: childThread,
          status: "error",
          activeTurnId: null,
          lastError: "stream closed",
          updatedAt: yield* nowIso,
        }),
      );
      yield* setSession(
        harness,
        makeSession({
          threadId: childThread,
          status: "running",
          activeTurnId: childTurn,
          updatedAt: yield* nowIso,
        }),
      );
      yield* sweepNow;
      const child2 = yield* reload(child.taskId);
      expect([child2.status, child2.result?.summary, child2.errorMessage]).toEqual([
        "completed",
        "Fixed.",
        null,
      ]);
      expect(startsOn(harness, rootThread).length).toBe(rootStarts);
      const detail = yield* service.get({ taskId: root.taskId });
      expect(detail.children.map((handoff) => handoff.status)).toEqual(["delivered"]);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "a duplicate terminal event with a fresh event id delivers a failed child to its parent once",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("dup-failed");
      const rootThread = threadOf(root);
      const rootTurn = yield* beginTurn(harness, rootThread);
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Break things"),
      });
      yield* endTurn(harness, rootThread, rootTurn, "Delegated.");
      const childThread = threadOf(yield* reload(child.taskId));
      yield* runTurn(harness, childThread, "", { status: "error", lastError: "Tool crashed" });
      const terminal = harness.sessions.get(childThread)!;
      for (const suffix of ["-replay-a", "-replay-b", "-replay-c"]) {
        yield* service.ingestDomainEvent(sessionEvent(harness, terminal, suffix));
        yield* service.drain;
      }
      yield* sweepNow;
      expect((yield* reload(child.taskId)).status).toBe("failed");
      const continuations = startsOn(harness, rootThread).slice(1);
      expect(continuations.length).toBe(1);
      expect(continuations[0]!.message.text).toContain("### Break things (failed)");
      expect(continuations[0]!.message.text).toContain("Task failed: Tool crashed");
      expect((yield* service.get({ taskId: root.taskId })).children.map((h) => h.status)).toEqual([
        "delivered",
      ]);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "a completion event that runs ahead of the projection settles nothing until the projection catches up, then once",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("ahead");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      // The event for "ready" reaches the dispatcher while the projection still says running.
      const ready = makeSession({
        threadId: thread,
        status: "ready",
        activeTurnId: null,
        updatedAt: yield* nowIso,
      });
      yield* service.ingestDomainEvent(sessionEvent(harness, ready));
      yield* service.drain;
      expect((yield* reload(root.taskId)).status).toBe("running");
      // The projection catches up (reply, then session); the sweep and a replay of the event finish it once.
      yield* writeReply(harness, thread, turnId, "All done.");
      harness.sessions.set(thread, ready);
      yield* sweepNow;
      yield* service.ingestDomainEvent(sessionEvent(harness, ready, "-again"));
      yield* sweepNow;
      const done = yield* reload(root.taskId);
      expect([done.status, done.result?.summary]).toEqual(["completed", "All done."]);
      expect((yield* service.get({ taskId: root.taskId })).attempts.length).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "a reply still streaming when the session turns ready is waited for, and the final text is the result",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("streaming");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      yield* writeReply(harness, thread, turnId, "Half a sent", true);
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "ready",
          activeTurnId: null,
          updatedAt: yield* nowIso,
        }),
      );
      yield* sweepNow;
      expect((yield* reload(root.taskId)).status).toBe("running");
      // The final message replaces the streaming one and the dispatcher is told about it.
      const list = harness.messages.get(thread)!;
      harness.messages.set(thread, [
        { ...list[0]!, text: "Half a sentence, finished.", isStreaming: false },
      ]);
      yield* sweepNow;
      const done = yield* reload(root.taskId);
      expect([done.status, done.result?.summary]).toEqual([
        "completed",
        "Half a sentence, finished.",
      ]);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "a session left over from an earlier attempt does not end a retry before it has run",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("stale-attempt");
      const thread = threadOf(root);
      yield* runTurn(harness, thread, "", { status: "error", lastError: "Tool crashed" });
      expect((yield* reload(root.taskId)).status).toBe("failed");
      yield* TestClock.adjust("1 minute");
      yield* service.retry({ taskId: root.taskId });
      yield* service.drain;
      // The projection still shows attempt 1's error; the new turn has not started.
      yield* sweepNow;
      yield* sweepNow;
      const waiting = yield* reload(root.taskId);
      expect(waiting.status).toBe("running");
      expect((yield* service.get({ taskId: root.taskId })).attempts.length).toBe(2);
      yield* runTurn(harness, thread, "Second time lucky.");
      const done = yield* reload(root.taskId);
      expect([done.status, done.result?.summary]).toEqual(["completed", "Second time lucky."]);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

// --- 3. completion and result delivery -----------------------------------------------

it.effect("a result delivered across a restart reaches the delegating bot once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-boundary-db-" });
    const dbPath = path.join(directory, "state.sqlite");
    const before = makeHarness();
    const ids = yield* Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("restart-delivery");
      const rootThread = threadOf(root);
      const rootTurn = yield* beginTurn(before, rootThread);
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Slow part"),
      });
      yield* endTurn(before, rootThread, rootTurn, "Delegated.");
      expect((yield* reload(root.taskId)).status).toBe("waiting_for_agent");
      return { rootId: root.taskId, childId: child.taskId, rootThread };
    }).pipe(Effect.provide(makeLayer(before, dbPath)));

    // The server restarts while the child is running; the child finishes on the new server.
    const after = makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* PersonalTaskService.PersonalTaskService;
      const childDetail = yield* service.get({ taskId: ids.childId });
      const childThread = threadOf(childDetail.task);
      // The old server's lease runs out first; the child's turn is unknown to the new server, so it is interrupted
      // and delivered to the parent as interrupted, once, rather than lost.
      yield* TestClock.adjust("3 minutes");
      yield* sweepNow;
      yield* sweepNow;
      expect((yield* reload(ids.childId)).status).toBe("interrupted");
      const continuations = startsOn(after, ids.rootThread);
      expect(continuations.length).toBe(1);
      expect(continuations[0]!.message.text).toContain("### Slow part (interrupted)");
      expect((yield* service.get({ taskId: ids.rootId })).children.map((h) => h.status)).toEqual([
        "delivered",
      ]);
      expect(childThread).toBeDefined();
    }).pipe(Effect.provide(makeLayer(after, dbPath)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "the newest reply of the turn is the result, and the delegating bot gets exactly that text",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("newest-reply");
      const rootThread = threadOf(root);
      const rootTurn = yield* beginTurn(harness, rootThread);
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Report"),
      });
      yield* endTurn(harness, rootThread, rootTurn, "Delegated.");
      const childThread = threadOf(yield* reload(child.taskId));
      const childTurn = yield* beginTurn(harness, childThread);
      yield* writeReply(harness, childThread, childTurn, "Looking into it.");
      yield* endTurn(
        harness,
        childThread,
        childTurn,
        "Root cause: a stale lock. Fixed and verified.",
      );
      const done = yield* reload(child.taskId);
      expect(done.result?.summary).toBe("Root cause: a stale lock. Fixed and verified.");
      const continuation = startsOn(harness, rootThread).at(-1)!;
      expect(continuation.message.text).toContain("Root cause: a stale lock. Fixed and verified.");
      expect(continuation.message.text).not.toContain("Looking into it.");
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "a cancelled task stays cancelled when its provider turn finishes anyway, and its parent hears once",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const root = yield* createRoot("cancel-late");
      const rootThread = threadOf(root);
      const rootTurn = yield* beginTurn(harness, rootThread);
      const child = yield* service.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: brief("Doomed"),
      });
      yield* endTurn(harness, rootThread, rootTurn, "Delegated.");
      const childThread = threadOf(yield* reload(child.taskId));
      const childTurn = yield* beginTurn(harness, childThread);
      yield* service.cancel({ taskId: child.taskId });
      yield* service.drain;
      expect((yield* reload(child.taskId)).status).toBe("cancelled");
      expect(interrupts(harness).some((command) => command.threadId === childThread)).toBe(true);
      // The provider finishes the turn anyway.
      yield* endTurn(harness, childThread, childTurn, "Finished before the stop landed.");
      yield* sweepNow;
      expect((yield* reload(child.taskId)).status).toBe("cancelled");
      expect((yield* reload(child.taskId)).result?.summary ?? "").not.toContain("Finished before");
      expect(startsOn(harness, rootThread).length).toBeLessThanOrEqual(2);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

// --- 4. usage limit and fallback -----------------------------------------------------

it.effect(
  "a limit report delivered twice moves the bot to its fallback once and runs the task once more",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const root = yield* createRoot("limit-twice", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const startsBefore = turnStarts(harness).length;
      const retry = yield* provider.codexLimit(harness, thread, turnId, 6 * 60 * 60_000);
      // The same terminal report again, twice, with fresh event ids.
      const terminal = harness.sessions.get(thread)!;
      yield* service.ingestDomainEvent(sessionEvent(harness, terminal, "-dup1"));
      yield* service.ingestDomainEvent(sessionEvent(harness, terminal, "-dup2"));
      yield* service.drain;
      yield* sweepNow;
      expect(retry.kind).toBe("rate_limited");
      const bot = Option.getOrThrow(yield* bots.getBotById({ botId: botId("developer") }));
      expect(bot.fallbackActive?.modelSelection.model).toBe("claude-sonnet-5-5");
      const resumed = turnStarts(harness).slice(startsBefore);
      expect(resumed.length).toBe(1);
      expect((yield* service.get({ taskId: root.taskId })).attempts.map((a) => a.attempt)).toEqual([
        1, 2,
      ]);
      // The fallback notice is one line, not three.
      expect(
        harness.dispatched.filter(
          (command) =>
            command.type === "thread.message.assistant.delta" &&
            command.delta.startsWith("Codex hit its usage limit."),
        ).length,
      ).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness, undefined, fallbackProviders(10))));
  },
);

it.effect(
  "the fallback kill switch (PERSONAL_MODEL_FALLBACK=off) makes a limited task wait for the reset instead of switching",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const root = yield* createRoot("limit-switch-off", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const retry = yield* provider.codexLimit(harness, thread, turnId, 3 * 60 * 60_000);
      const bot = Option.getOrThrow(yield* bots.getBotById({ botId: botId("developer") }));
      expect(bot.fallbackActive).toBeUndefined();
      const paused = yield* reload(root.taskId);
      expect([paused.status, paused.errorCategory]).toEqual(["rate_limited", "rate_limited"]);
      expect(DateTime.toEpochMillis(paused.availableAt!)).toBe(Date.parse(retry.retryAt!));
      yield* sweepNow;
      expect(turnStarts(harness).length).toBe(1);
    }).pipe(
      Effect.provide(
        makeLayer(harness, undefined, fallbackProviders(10), { PERSONAL_MODEL_FALLBACK: "off" }),
      ),
    );
  },
);

it.effect(
  "a limit on the fallback itself waits for its reset: no third attempt, no switch back and forth",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalTaskService.PersonalTaskService;
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const root = yield* createRoot("limit-on-fallback", "developer");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      yield* provider.codexLimit(harness, thread, turnId, 6 * 60 * 60_000);
      yield* sweepNow;
      const switched = Option.getOrThrow(yield* bots.getBotById({ botId: botId("developer") }));
      expect(switched.fallbackActive?.modelSelection.instanceId).toBe("claudeAgent");
      expect((yield* service.get({ taskId: root.taskId })).attempts.length).toBe(2);

      // Attempt 2 runs on the fallback provider and hits that provider's own limit.
      yield* TestClock.adjust("1 second");
      const turn2 = yield* beginTurn(harness, thread, "-fallback");
      const now = yield* DateTime.now;
      const limit = providerWait("rate_limited", "claudeAgent", now, 2 * 60 * 60_000);
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "running",
          activeTurnId: turn2,
          providerRetry: limit,
          providerInstanceId: "claudeAgent",
          updatedAt: DateTime.formatIso(now),
        }),
      );
      yield* sweepNow;
      const parked = yield* reload(root.taskId);
      expect([parked.status, parked.errorCategory]).toEqual(["rate_limited", "rate_limited"]);
      expect(DateTime.toEpochMillis(parked.availableAt!)).toBe(Date.parse(limit.retryAt!));
      const startsAfter = turnStarts(harness).length;
      yield* sweepNow;
      yield* sweepNow;
      expect(turnStarts(harness).length).toBe(startsAfter);
      expect((yield* service.get({ taskId: root.taskId })).attempts.length).toBe(2);
    }).pipe(Effect.provide(makeLayer(harness, undefined, fallbackProviders(10))));
  },
);

it.effect(
  "a Claude turn parked on a spent window hands its slot back and is not run again until the reset",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedBots;
      const root = yield* createRoot("claude-parked");
      const thread = threadOf(root);
      const turnId = yield* beginTurn(harness, thread);
      const retry = yield* provider.claudeParked(harness, thread, turnId, 4 * 60 * 60_000);
      const parked = yield* reload(root.taskId);
      expect([parked.status, parked.errorCategory]).toEqual(["rate_limited", "rate_limited"]);
      expect(DateTime.toEpochMillis(parked.availableAt!)).toBe(Date.parse(retry.retryAt!));
      expect(interrupts(harness).filter((command) => command.threadId === thread).length).toBe(1);
      // The turn's own "interrupted" snapshot afterwards, and sweeps up to the reset, change nothing.
      yield* setSession(
        harness,
        makeSession({
          threadId: thread,
          status: "interrupted",
          activeTurnId: null,
          updatedAt: yield* nowIso,
        }),
      );
      yield* TestClock.adjust("3 hours");
      yield* sweepNow;
      expect((yield* reload(root.taskId)).status).toBe("rate_limited");
      expect(turnStarts(harness).length).toBe(1);
      yield* TestClock.adjust("2 hours");
      yield* sweepNow;
      expect((yield* reload(root.taskId)).status).toBe("running");
      expect(turnStarts(harness).length).toBe(2);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);
