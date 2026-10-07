// Provider-boundary tests for delegated tasks. A scripted fake provider plays the adapter side: it publishes
// ProviderRuntimeEvents (turn.started, content.delta, item.completed, runtime.error, turn.completed,
// session.exited ...) in the shapes and orders the real adapters produce, including duplicates and late events.
// They go through the REAL ProviderRuntimeIngestion, orchestration engine and projections (in-memory SQLite)
// into the REAL PersonalTaskService, so nothing between the provider and the task result is mocked. (1.65.0's two
// major bugs were Codex event ordering that unit mocks of the session and browser scripts both missed.)
// taskProviderBoundary.test.ts covers the same ground one step later (the projected session), with a crash, a
// lease expiry and a restart.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  PersonalBotId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type PersonalTask,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../../orchestration/Services/ProviderRuntimeIngestion.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import * as PersonalTaskService from "./PersonalTaskService.ts";

/** What a scripted provider event carries; the harness fills in event id, provider and time. */
type Script = Record<string, unknown> & { readonly type: ProviderRuntimeEvent["type"] };

const CODEX = ProviderDriverKind.make("codex");
const turn = (id: string) => TurnId.make(id);
const botId = (name: string) => PersonalBotId.make(`bot-${name}`);

/** The scripted adapter: a provider service whose runtime event stream is whatever the test publishes. */
const makeFakeProvider = Effect.gen(function* () {
  const bus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  let sequence = 0;
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    assertConversationRollbackSupported: () => unsupported(),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    uploadFeedback: () => unsupported(),
    streamEvents: Stream.fromPubSub(bus),
  };
  /** Publishes one event as the adapter would. Passing the same `eventId` twice is a duplicate delivery. */
  const emit = (threadId: ThreadId, script: Script, eventId?: string) =>
    Effect.gen(function* () {
      sequence += 1;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* PubSub.publish(bus, {
        provider: CODEX,
        threadId,
        createdAt: at,
        ...script,
        eventId: EventId.make(eventId ?? `fake-provider-${sequence}`),
      } as unknown as ProviderRuntimeEvent);
    });
  return { service, emit };
});
type FakeProvider = Effect.Success<typeof makeFakeProvider>;

const makeChainLayer = (provider: FakeProvider) => {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const snapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  return PersonalTaskService.layer.pipe(
    Layer.provideMerge(PersonalTaskRepository.layer),
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(ProviderRuntimeIngestionLive),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(snapshotLayer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(
      Layer.effect(
        CheckpointStore.CheckpointStore,
        Effect.map(CheckpointStore.CheckpointStore, (store) => ({
          ...store,
          isGitRepository: () => Effect.succeed(false),
        })),
      ).pipe(Layer.provide(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer)))),
    ),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-chain-" })),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Starts the real ingestion and the task dispatcher, seeds two bots and returns the test's helpers. */
const buildHarness = (provider: FakeProvider) =>
  Effect.gen(function* () {
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const bots = yield* PersonalBotService.PersonalBotService;
    const ingestion = yield* ProviderRuntimeIngestionService;
    const snapshots = yield* ProjectionSnapshotQuery;
    yield* ingestion.start();
    yield* tasks.start();
    for (const name of ["assistant", "developer"]) {
      yield* bots.create({
        botId: botId(name),
        name: name[0]!.toUpperCase() + name.slice(1),
        description: "",
        instructions: "",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
      });
    }
    const get = (task: PersonalTask) => tasks.get({ taskId: task.taskId });
    const createRoot = (key: string) =>
      Effect.gen(function* () {
        const task = yield* tasks.createTask({
          idempotencyKey: key,
          botId: botId("assistant"),
          title: `Root ${key}`,
          objective: `Do the ${key} thing.`,
        });
        yield* tasks.drain;
        return task;
      });
    const threadOf = (task: PersonalTask) =>
      Effect.gen(function* () {
        const detail = yield* get(task);
        if (detail.task.threadId === null) throw new Error(`task ${task.taskId} has no thread yet`);
        return detail.task.threadId;
      });
    /** Polls until `ok` holds for the task's detail. A ceiling, not a delay. */
    const until = (
      task: PersonalTask,
      ok: (detail: Effect.Success<ReturnType<typeof get>>) => boolean,
      label: string,
    ) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + 10_000;
        let detail = yield* get(task);
        while (!ok(detail)) {
          if ((yield* Clock.currentTimeMillis) > deadline) {
            throw new Error(
              `timed out waiting for ${label}; task is ${detail.task.status} (${detail.task.errorMessage ?? "no error"})`,
            );
          }
          yield* Effect.sleep("20 millis");
          detail = yield* get(task);
        }
        return detail;
      });
    /** Lets everything already published reach the projections and the task dispatcher. */
    const settleAll = Effect.gen(function* () {
      for (let i = 0; i < 3; i += 1) {
        yield* ingestion.drain;
        yield* tasks.drain;
        yield* Effect.sleep("40 millis");
      }
    });
    const thread = (threadId: ThreadId) =>
      snapshots
        .getSnapshot()
        .pipe(Effect.map((snapshot) => snapshot.threads.find((entry) => entry.id === threadId)));
    return { provider, tasks, get, createRoot, threadOf, until, settleAll, thread };
  });

type Harness = Effect.Success<ReturnType<typeof buildHarness>>;

/** One test: a fresh fake provider and a fresh in-memory server, on the real clock (events cross fibers). */
const chainTest = <E>(
  name: string,
  body: (h: Harness) => Effect.Effect<void, E>,
  options: { readonly fails?: boolean } = {},
) =>
  (options.fails === true ? it.live.fails : it.live)(
    name,
    () =>
      Effect.gen(function* () {
        const provider = yield* makeFakeProvider;
        yield* Effect.gen(function* () {
          yield* body(yield* buildHarness(provider));
        }).pipe(Effect.provide(makeChainLayer(provider)), Effect.orDie);
      }),
    20_000,
  );

/** The adapters' order for an assistant reply: text deltas, then the completed message item. */
const say = (h: Harness, thread: ThreadId, turnId: string, text: string) =>
  Effect.gen(function* () {
    const itemId = `msg-${thread}-${turnId}`;
    yield* h.provider.emit(thread, {
      type: "content.delta",
      turnId: turn(turnId),
      itemId,
      payload: { streamKind: "assistant_text", delta: text },
    });
    yield* h.provider.emit(thread, {
      type: "item.completed",
      turnId: turn(turnId),
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        detail: text,
      },
    });
  });
const start = (h: Harness, thread: ThreadId, turnId: string) =>
  h.provider.emit(thread, { type: "turn.started", turnId: turn(turnId) });
const complete = (
  h: Harness,
  thread: ThreadId,
  turnId: string,
  payload: Record<string, unknown> = { state: "completed" },
  eventId?: string,
) => h.provider.emit(thread, { type: "turn.completed", turnId: turn(turnId), payload }, eventId);

const LIMIT_TEXT = "Codex usage limit reached. Try again later.";
const inHours = (hours: number) =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    DateTime.formatIso(DateTime.makeUnsafe(now + hours * 3_600_000)),
  );

// --- completion and result delivery -----------------------------------------------

chainTest(
  "a one-paragraph reply ends the task with the whole reply as its result (paragraph streaming)",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("one-paragraph");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      yield* say(h, thread, "t1", "The build is green.");
      yield* complete(h, thread, "t1");
      const done = yield* h.until(
        root,
        (d) => d.task.status === "completed",
        "the task to complete",
      );
      expect(done.task.result?.summary).toBe("The build is green.");
    }),
);

chainTest("a multi-paragraph reply is the result in full, not its first paragraphs", (h) =>
  Effect.gen(function* () {
    const root = yield* h.createRoot("multi-paragraph");
    const thread = yield* h.threadOf(root);
    yield* start(h, thread, "t1");
    yield* say(h, thread, "t1", "First paragraph.\n\nSecond paragraph.\n\nThird.");
    yield* complete(h, thread, "t1");
    const done = yield* h.until(root, (d) => d.task.status === "completed", "the task to complete");
    expect(done.task.result?.summary).toBe("First paragraph.\n\nSecond paragraph.\n\nThird.");
  }),
);

chainTest(
  "a duplicate turn.completed (same event id, then a new id) completes the task once with the same result",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("dup-completed");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      yield* say(h, thread, "t1", "Done once.");
      yield* complete(h, thread, "t1", { state: "completed" }, "completed-evt");
      yield* complete(h, thread, "t1", { state: "completed" }, "completed-evt");
      yield* complete(h, thread, "t1", { state: "completed" });
      yield* h.until(root, (d) => d.task.status === "completed", "the task to complete");
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect(detail.task.status).toBe("completed");
      expect(detail.task.result?.summary).toBe("Done once.");
      expect(detail.attempts.length).toBe(1);
      const messages = (yield* h.thread(thread))?.messages ?? [];
      expect(messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual([
        "Done once.",
      ]);
    }),
);

chainTest("provider events after the task finished (a late session exit) change nothing", (h) =>
  Effect.gen(function* () {
    const root = yield* h.createRoot("late-after-done");
    const thread = yield* h.threadOf(root);
    yield* start(h, thread, "t1");
    yield* say(h, thread, "t1", "All done.");
    yield* complete(h, thread, "t1");
    yield* h.until(root, (d) => d.task.status === "completed", "the task to complete");
    yield* h.provider.emit(thread, {
      type: "session.exited",
      payload: { reason: "process exited" },
    });
    yield* h.settleAll;
    const detail = yield* h.get(root);
    expect([detail.task.status, detail.task.result?.summary, detail.task.errorMessage]).toEqual([
      "completed",
      "All done.",
      null,
    ]);
    expect(detail.attempts.length).toBe(1);
  }),
);

chainTest(
  "the delegating bot gets the child's reply once, as the continuation of its own task",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("delegating");
      const rootThread = yield* h.threadOf(root);
      yield* start(h, rootThread, "root-1");
      const child = yield* h.tasks.delegate({
        parentTaskId: root.taskId,
        targetBotId: botId("developer"),
        brief: { title: "Check the build", objective: "Check the build objective" },
      });
      yield* say(h, rootThread, "root-1", "Delegated to Developer.");
      yield* complete(h, rootThread, "root-1");
      yield* h.until(
        root,
        (d) => d.task.status === "waiting_for_agent",
        "the parent to wait for its child",
      );
      yield* h.tasks.drain;
      const childThread = yield* h.threadOf(child);
      yield* start(h, childThread, "child-1");
      yield* say(h, childThread, "child-1", "Build is green on main.");
      // The same terminal event delivered twice.
      yield* complete(h, childThread, "child-1", { state: "completed" }, "child-done");
      yield* complete(h, childThread, "child-1", { state: "completed" }, "child-done");
      yield* h.until(child, (d) => d.task.status === "completed", "the child to complete");
      yield* h.until(
        root,
        (d) => d.children.some((handoff) => handoff.status === "delivered"),
        "the child's result to be delivered",
      );
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect(detail.children.map((handoff) => [handoff.status, handoff.resultSummary])).toEqual([
        ["delivered", "Build is green on main."],
      ]);
      const continuations = ((yield* h.thread(rootThread))?.messages ?? []).filter(
        (message) => message.role === "user" && message.text.includes("Build is green on main."),
      );
      expect(continuations.length).toBe(1);
      expect(detail.task.status).toBe("running");
      expect(detail.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    }),
);

// --- usage limit ----------------------------------------------------------------------

chainTest(
  "a Codex limit reported as an error, then a failed completion with the reset, parks the task until the reset",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("codex-limit");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      yield* h.provider.emit(thread, {
        type: "runtime.error",
        turnId: turn("t1"),
        payload: { message: LIMIT_TEXT },
      });
      const resetAt = yield* inHours(3);
      yield* complete(h, thread, "t1", {
        state: "failed",
        errorMessage: LIMIT_TEXT,
        retry: { kind: "rate_limited", retryAt: resetAt, reason: "usageLimitExceeded" },
      });
      const parked = yield* h.until(
        root,
        (d) => d.task.status === "rate_limited",
        "the task to wait for the reset",
      );
      expect(parked.task.errorCategory).toBe("rate_limited");
      expect(DateTime.toEpochMillis(parked.task.availableAt!)).toBe(Date.parse(resetAt));
      expect(parked.attempts.length).toBe(1);
    }),
);

chainTest(
  "the same limit reported in the other order (completion first, error after) still parks it on the reported reset",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("codex-limit-reversed");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      const resetAt = yield* inHours(2);
      yield* complete(h, thread, "t1", {
        state: "failed",
        errorMessage: LIMIT_TEXT,
        retry: { kind: "rate_limited", retryAt: resetAt, reason: "usageLimitExceeded" },
      });
      yield* h.provider.emit(thread, {
        type: "runtime.error",
        turnId: turn("t1"),
        payload: { message: LIMIT_TEXT },
      });
      yield* h.until(
        root,
        (d) => d.task.status === "rate_limited",
        "the task to wait for the reset",
      );
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect(detail.task.status).toBe("rate_limited");
      expect(DateTime.toEpochMillis(detail.task.availableAt!)).toBe(Date.parse(resetAt));
      expect(detail.attempts.length).toBe(1);
    }),
);

chainTest(
  "a duplicate limit report (same event ids, then new ids) parks the task once and starts nothing",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("limit-dup");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      const resetAt = yield* inHours(4);
      const limit = {
        state: "failed",
        errorMessage: LIMIT_TEXT,
        retry: { kind: "rate_limited", retryAt: resetAt, reason: "usageLimitExceeded" },
      };
      yield* complete(h, thread, "t1", limit, "limit-evt");
      yield* complete(h, thread, "t1", limit, "limit-evt");
      yield* complete(h, thread, "t1", limit);
      yield* h.until(
        root,
        (d) => d.task.status === "rate_limited",
        "the task to wait for the reset",
      );
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect([detail.task.status, detail.attempts.length]).toEqual(["rate_limited", 1]);
      expect(DateTime.toEpochMillis(detail.task.availableAt!)).toBe(Date.parse(resetAt));
    }),
);

// --- interruption ---------------------------------------------------------------------

chainTest(
  "the adapter process dying mid-turn leaves the task interrupted and resumable, and nothing re-runs it",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("crash");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      yield* h.provider.emit(thread, {
        type: "session.exited",
        payload: { reason: "Codex process exited (code 1)", exitKind: "error" },
      });
      const stopped = yield* h.until(
        root,
        (d) => d.task.status === "interrupted",
        "the task to be interrupted",
      );
      expect(stopped.attempts.length).toBe(1);
      yield* h.settleAll;
      yield* h.tasks.sweep;
      yield* h.settleAll;
      const after = yield* h.get(root);
      expect([after.task.status, after.attempts.length]).toEqual(["interrupted", 1]);
      // retry is the way back: attempt 2 on the same thread.
      yield* h.tasks.retry({ taskId: root.taskId });
      yield* h.tasks.drain;
      const retried = yield* h.get(root);
      expect(retried.task.status).toBe("running");
      expect(retried.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
      expect(retried.attempts[1]!.providerThreadId).toBe(thread);
    }),
);

chainTest(
  "a turn the user stops is interrupted; a completion the adapter reports for it afterwards does not complete the task",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("user-stop");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      yield* h.provider.emit(thread, {
        type: "turn.aborted",
        turnId: turn("t1"),
        payload: { reason: "Interrupted by user." },
      });
      yield* h.until(root, (d) => d.task.status === "interrupted", "the task to be interrupted");
      yield* say(h, thread, "t1", "Partial work.");
      yield* complete(h, thread, "t1");
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect(detail.task.status).toBe("interrupted");
      expect(detail.attempts.length).toBe(1);
    }),
);

// KNOWN GAP (found by this test, reported in docs/releases/HANDOFF-evidence.md, not fixed: it is the core
// ingestion path and no adapter is known to send it): ProviderRuntimeIngestion only rejects a turn.started that
// CONFLICTS with the active turn. With no active turn, a turn.started replayed under a new event id for a turn
// that already completed sets the thread session back to running with that turn active, and nothing ends it.
// `fails: true` documents the wanted behaviour and starts failing the day the guard is added: then drop it.
chainTest(
  "a turn.started that arrives after its own turn.completed does not leave the chat running",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("late-started");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread, "t1");
      yield* say(h, thread, "t1", "Quick one.");
      yield* complete(h, thread, "t1");
      yield* h.until(root, (d) => d.task.status === "completed", "the task to complete");
      // Delivered out of order: the start of a turn that has already completed.
      yield* start(h, thread, "t1");
      yield* h.settleAll;
      const session = (yield* h.thread(thread))?.session;
      expect([session?.status, session?.activeTurnId]).toEqual(["ready", null]);
      expect((yield* h.get(root)).task.status).toBe("completed");
    }),
  { fails: true },
);
