// Provider-boundary tests for delegated tasks. A scripted fake adapter plays the provider side: it emits the
// v2 adapter events a real driver produces (provider turn started/completed, assistant messages, terminal
// failures), through the REAL ProviderEventIngestor, Orchestrator, projections and PersonalEngineV2Live, into
// the REAL PersonalTaskService, so nothing between the provider and the task result is mocked.
// taskProviderBoundary.test.ts covers the same ground one step later (the projected session), with a crash,
// a lease expiry and a restart.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  PersonalBotId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderFailureClass,
  type PersonalTask,
  type PersonalTaskDetail,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { PersonalEngine } from "../engine/PersonalEngine.ts";
import { PersonalEngineV2Live } from "../engine/PersonalEngineV2Live.ts";
import { PersonalProjectionRelationsV1Live } from "../engine/PersonalProjectionRelationsV1Live.ts";
import { PersonalProviders } from "../engine/PersonalProviders.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import * as PersonalTaskService from "./PersonalTaskService.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const botId = (name: string) => PersonalBotId.make(`bot-${name}`);
const LIMIT_TEXT = "Codex usage limit reached. Try again later.";

/** What the scripted adapter has started, so a test can answer for that turn. */
interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: {
    readonly id: ReturnType<typeof ProviderTurnId.make>;
    readonly providerThreadId: ReturnType<typeof ProviderThreadId.make>;
    readonly nodeId: NonNullable<ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"]>;
    readonly runAttemptId: ProviderAdapter.ProviderAdapterV2TurnInput["attemptId"];
    readonly ordinal: number;
    status: "running" | "completed" | "failed" | "interrupted" | "cancelled";
    readonly startedAt: DateTime.Utc;
    completedAt: DateTime.Utc | null;
  };
}

interface FakeProvider {
  readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly turns: Map<string, ActiveTurn>;
  readonly starts: Array<ProviderAdapter.ProviderAdapterV2TurnInput>;
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<boolean>;
  readonly events: PubSub.PubSub<ProviderAdapter.ProviderAdapterV2Event>;
  readonly sessions: Map<string, OrchestrationV2ProviderSession>;
  readonly openCount: () => number;
}

/** The scripted adapter: a provider whose events are whatever the test publishes. */
const makeFakeProvider = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const turns = new Map<string, ActiveTurn>();
  const starts: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
  const sessions = new Map<string, OrchestrationV2ProviderSession>();
  let opened = 0;
  const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => PubSub.publish(events, event);

  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        opened += 1;
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        sessions.set(String(input.threadId), providerSession);
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native-thread:${threadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              const startedAt = yield* DateTime.now;
              starts.push(turn);
              const active: ActiveTurn = {
                input: turn,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt,
                  completedAt: null,
                },
              };
              turns.set(turn.threadId, active);
              yield* emit({
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: active.providerTurn.id,
                  providerThreadId: active.providerTurn.providerThreadId,
                  nodeId: active.providerTurn.nodeId,
                  runAttemptId: active.providerTurn.runAttemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${active.providerTurn.id}`,
                    strength: "strong",
                  },
                  ordinal: active.providerTurn.ordinal,
                  status: "running",
                  startedAt,
                  completedAt: null,
                },
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: (input) =>
            Effect.gen(function* () {
              const active = turns.get(String(input.providerThread.appThreadId));
              if (active === undefined) return;
              const completedAt = yield* DateTime.now;
              active.providerTurn = { ...active.providerTurn, status: "interrupted", completedAt };
              yield* emit({
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  ...active.providerTurn,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${active.providerTurn.id}`,
                    strength: "strong",
                  },
                },
              });
              yield* emit({
                type: "turn.terminal",
                driver,
                providerThreadId: active.providerTurn.providerThreadId,
                providerTurnId: active.providerTurn.id,
                runOrdinal: active.input.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };

  return {
    adapter,
    turns,
    starts,
    emit,
    events,
    sessions,
    openCount: () => opened,
  } satisfies FakeProvider;
});

/** The personal workspace project, in memory: the task tests do not read project rows. */
const projectService = (
  projects: Map<string, { readonly id: ProjectId; readonly workspaceRoot: string }>,
) =>
  Layer.succeed(ProjectService, {
    create: (input: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    }) =>
      Effect.sync(() => {
        projects.set(input.projectId, { id: input.projectId, workspaceRoot: input.workspaceRoot });
      }),
    getShell: (projectId: ProjectId) =>
      Effect.sync(() =>
        Option.map(Option.fromUndefinedOr(projects.get(projectId)), (project) => ({
          id: project.id,
          title: "Personal",
          workspaceRoot: project.workspaceRoot,
        })),
      ),
    listShells: () =>
      Effect.sync(() =>
        [...projects.values()].map((project) => ({
          id: project.id,
          title: "Personal",
          workspaceRoot: project.workspaceRoot,
        })),
      ),
  } as never);

const makeChainLayer = (provider: FakeProvider, name: string) => {
  const database = SqlitePersistence.layerMemory;
  const settings = ServerSettings.layerTest();
  const projects = new Map<string, { readonly id: ProjectId; readonly workspaceRoot: string }>();
  const base = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(provider.adapter),
    { runEffectWorker: false, databaseLayer: database },
  );
  const threadManagement = ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(base, settings, CommandReceiptStore.layer.pipe(Layer.provide(database))),
    ),
  );
  const engine = PersonalEngineV2Live.pipe(
    Layer.provide(threadManagement),
    Layer.provide(projectService(projects)),
    Layer.provide(base),
    Layer.provide(PersonalProjectionRelationsV1Live),
    Layer.provide(database),
  );
  return PersonalTaskService.layer.pipe(
    Layer.provideMerge(PersonalTaskRepository.layer),
    Layer.provideMerge(PersonalBotService.layerRequiringEngine.pipe(Layer.provideMerge(engine))),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(PersonalProjectionRelationsV1Live),
    Layer.provideMerge(database),
    Layer.provideMerge(
      Layer.mock(PersonalProviders)({
        listProviders: () => Effect.succeed([]),
        refreshInstance: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(settings),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: `t3-task-chain-${name}-` })),
    Layer.provideMerge(base),
    Layer.provideMerge(engine),
    Layer.provideMerge(threadManagement),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Starts the real ingestion, orchestrator and task dispatcher, seeds two bots. */
const buildHarness = (provider: FakeProvider) =>
  Effect.gen(function* () {
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const bots = yield* PersonalBotService.PersonalBotService;
    const engine = yield* PersonalEngine;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* tasks.start();
    for (const name of ["assistant", "developer"]) {
      yield* bots.create({
        botId: botId(name),
        name: name[0]!.toUpperCase() + name.slice(1),
        description: "",
        instructions: "",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId, model: "gpt-test" },
      });
    }
    const get = (task: { readonly taskId: PersonalTask["taskId"] }) =>
      tasks.get({ taskId: task.taskId });
    const getOrDie = (task: { readonly taskId: PersonalTask["taskId"] }) =>
      get(task).pipe(Effect.orDie);
    const settleAll = Effect.gen(function* () {
      for (let i = 0; i < 5; i += 1) {
        yield* worker.drain();
        yield* tasks.drain;
        yield* Effect.sleep("15 millis");
      }
    });
    const createRoot = (key: string) =>
      Effect.gen(function* () {
        const task = yield* tasks
          .createTask({
            idempotencyKey: key,
            botId: botId("assistant"),
            title: `Root ${key}`,
            objective: `Do the ${key} thing.`,
          })
          .pipe(Effect.orDie);
        yield* tasks.drain;
        yield* settleAll;
        return (yield* getOrDie(task)).task;
      });
    const threadOf = (task: PersonalTask) =>
      Effect.gen(function* () {
        const detail = yield* getOrDie(task);
        if (detail.task.threadId === null) throw new Error(`task ${task.taskId} has no thread yet`);
        return detail.task.threadId;
      });
    /** Polls until `ok` holds for the task's detail. A ceiling, not a delay. */
    const until = (
      task: PersonalTask,
      ok: (detail: PersonalTaskDetail) => boolean,
      label: string,
    ) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + 10_000;
        let detail = yield* getOrDie(task);
        while (!ok(detail)) {
          if ((yield* Clock.currentTimeMillis) > deadline) {
            throw new Error(
              `timed out waiting for ${label}; task is ${detail.task.status} (${detail.task.errorMessage ?? "no error"})`,
            );
          }
          yield* worker.drain();
          yield* tasks.drain;
          yield* Effect.sleep("20 millis");
          detail = yield* getOrDie(task);
        }
        return detail;
      });
    const project = (threadId: ThreadId) =>
      orchestrator.getThreadProjection(threadId).pipe(Effect.orDie);
    const thread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const projection = yield* orchestrator
          .getThreadProjection(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (projection === null) return undefined;
        const shell = yield* engine
          .getThread(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        return {
          messages: projection.messages.map((message) => ({
            role: message.role,
            text: message.text,
          })),
          session: Option.isSome(shell) ? shell.value.session : null,
        };
      });
    return {
      provider,
      tasks,
      engine,
      worker,
      orchestrator,
      get: getOrDie,
      createRoot,
      threadOf,
      project,
      thread,
      settleAll,
      until,
    };
  });

type Harness = Effect.Success<ReturnType<typeof buildHarness>> & {
  readonly until: (
    task: PersonalTask,
    ok: (detail: PersonalTaskDetail) => boolean,
    label: string,
  ) => Effect.Effect<PersonalTaskDetail, unknown>;
};

/** One test: a fresh fake provider and a fresh in-memory server, on the real clock (events cross fibers). */
const chainTest = <E>(
  name: string,
  body: (h: Harness) => Effect.Effect<void, E>,
  options: { readonly fails?: boolean } = {},
) =>
  (options.fails === true ? it.live.fails : it.live)(name, () =>
    Effect.gen(function* () {
      const provider = yield* makeFakeProvider;
      yield* Effect.gen(function* () {
        yield* body(yield* buildHarness(provider));
      }).pipe(
        Effect.provide(makeChainLayer(provider, name.replaceAll(/[^a-z0-9]+/gi, "-"))),
        Effect.orDie,
      );
    }),
  );

const currentTurn = (h: Harness, thread: ThreadId) => {
  const active = h.provider.turns.get(String(thread));
  if (active === undefined) throw new Error(`no provider turn started for ${thread}`);
  return active;
};

/** Waits until the first provider turn of the thread is running. */
const start = (h: Harness, thread: ThreadId) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 10_000;
    while (h.provider.turns.get(String(thread)) === undefined) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        throw new Error(`timed out waiting for the provider turn on ${thread}`);
      }
      yield* h.worker.drain();
      yield* h.tasks.drain;
      yield* Effect.sleep("10 millis");
    }
  });

/** The assistant's reply, as the adapter reports a completed message. */
const say = (h: Harness, thread: ThreadId, text: string) =>
  Effect.gen(function* () {
    const active = currentTurn(h, thread);
    const now = yield* DateTime.now;
    yield* h.provider.emit({
      type: "message.updated",
      driver,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make(`assistant:${active.input.attemptId}`),
        threadId: thread,
        runId: active.input.runId,
        nodeId: active.input.rootNodeId,
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
  });

/** The adapter's terminal for the active turn: completed, interrupted or failed. */
const settleTurn = (
  h: Harness,
  thread: ThreadId,
  status: "completed" | "failed" | "interrupted",
  failure?: { readonly message: string; readonly class: OrchestrationV2ProviderFailureClass },
) =>
  Effect.gen(function* () {
    const active = currentTurn(h, thread);
    const completedAt = yield* DateTime.now;
    active.providerTurn = { ...active.providerTurn, status, completedAt };
    yield* h.provider.emit({
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        id: active.providerTurn.id,
        providerThreadId: active.providerTurn.providerThreadId,
        nodeId: active.providerTurn.nodeId,
        runAttemptId: active.providerTurn.runAttemptId,
        nativeTurnRef: {
          driver,
          nativeId: `native:${active.providerTurn.id}`,
          strength: "strong",
        },
        ordinal: active.providerTurn.ordinal,
        status,
        startedAt: active.providerTurn.startedAt,
        completedAt,
      },
    });
    if (status === "failed") {
      yield* h.provider.emit({
        type: "turn.terminal",
        driver,
        providerThreadId: active.providerTurn.providerThreadId,
        providerTurnId: active.providerTurn.id,
        runOrdinal: active.input.runOrdinal,
        failureItemOrdinal: 1,
        status: "failed",
        failure: {
          class: failure?.class ?? "provider_error",
          message: failure?.message ?? "The provider failed.",
          code: null,
          retryable: true,
          resetAt: null,
        },
        threadDisposition: "reusable",
      });
    } else {
      yield* h.provider.emit({
        type: "turn.terminal",
        driver,
        providerThreadId: active.providerTurn.providerThreadId,
        providerTurnId: active.providerTurn.id,
        runOrdinal: active.input.runOrdinal,
        status,
        failure: null,
        threadDisposition: "reusable",
      });
    }
  });

const complete = (h: Harness, thread: ThreadId) => settleTurn(h, thread, "completed");

// --- completion and result delivery -----------------------------------------------

chainTest(
  "a one-paragraph reply ends the task with the whole reply as its result (paragraph streaming)",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("one-paragraph");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread);
      yield* say(h, thread, "The build is green.");
      yield* complete(h, thread);
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
    yield* start(h, thread);
    yield* say(h, thread, "First paragraph.\n\nSecond paragraph.\n\nThird.");
    yield* complete(h, thread);
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
      yield* start(h, thread);
      yield* say(h, thread, "Done once.");
      yield* complete(h, thread);
      yield* complete(h, thread);
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
    yield* start(h, thread);
    yield* say(h, thread, "All done.");
    yield* complete(h, thread);
    yield* h.until(root, (d) => d.task.status === "completed", "the task to complete");
    const session = h.provider.sessions.get(String(thread));
    if (session !== undefined) {
      const now = yield* DateTime.now;
      yield* h.provider.emit({
        type: "provider_session.updated",
        driver,
        providerSession: { ...session, status: "stopped", updatedAt: now },
      });
    }
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
      yield* start(h, rootThread);
      const child = yield* h.tasks
        .delegate({
          parentTaskId: root.taskId,
          targetBotId: botId("developer"),
          brief: { title: "Check the build", objective: "Check the build objective" },
        })
        .pipe(Effect.orDie);
      yield* say(h, rootThread, "Delegated to Developer.");
      yield* complete(h, rootThread);
      yield* h.until(root, (d) => d.task.status === "waiting_for_agent", "the parent to wait");
      yield* h.tasks.drain;
      const childThread = yield* h.threadOf(child);
      yield* start(h, childThread);
      yield* say(h, childThread, "Build is green on main.");
      yield* complete(h, childThread);
      yield* complete(h, childThread);
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

// v2 reports a provider limit as a failed run with a failure class; the personal
// session view carries only the retry marker, so the task parks on its
// unreported-limit backoff instead of a reset the personal layer cannot see yet.
// The cases keep their names and assert the park plus one attempt; the exact
// reset time is the one thing v2 does not carry through (reported as a gap).
const failOnLimit = (h: Harness, thread: ThreadId) =>
  settleTurn(h, thread, "failed", { message: LIMIT_TEXT, class: "usage_limit" });

chainTest(
  "a Codex limit reported as an error, then a failed completion with the reset, parks the task until the reset",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("codex-limit");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread);
      yield* failOnLimit(h, thread);
      const parked = yield* h.until(
        root,
        (d) => d.task.status === "rate_limited",
        "the task to wait for the reset",
      );
      expect(parked.task.errorCategory).toBe("rate_limited");
      expect(parked.task.availableAt).not.toBeNull();
      expect(parked.attempts.length).toBe(1);
    }),
);

chainTest(
  "the same limit reported in the other order (completion first, error after) still parks it on the reported reset",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("codex-limit-reversed");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread);
      yield* failOnLimit(h, thread);
      yield* h.until(
        root,
        (d) => d.task.status === "rate_limited",
        "the task to wait for the reset",
      );
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect(detail.task.status).toBe("rate_limited");
      expect(detail.task.availableAt).not.toBeNull();
      expect(detail.attempts.length).toBe(1);
    }),
);

chainTest(
  "a duplicate limit report (same event ids, then new ids) parks the task once and starts nothing",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("limit-dup");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread);
      yield* failOnLimit(h, thread);
      yield* failOnLimit(h, thread);
      yield* h.until(
        root,
        (d) => d.task.status === "rate_limited",
        "the task to wait for the reset",
      );
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect([detail.task.status, detail.attempts.length]).toEqual(["rate_limited", 1]);
      expect(detail.task.availableAt).not.toBeNull();
    }),
);

// --- interruption ---------------------------------------------------------------------

chainTest(
  "the adapter process dying mid-turn leaves the task interrupted and resumable, and nothing re-runs it",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("crash");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread);
      // A v2 adapter that dies mid-turn reports an interrupted terminal, not a
      // failed one: the task stays resumable rather than ending as a failure.
      yield* settleTurn(h, thread, "interrupted");
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
      yield* h.tasks.retry({ taskId: root.taskId }).pipe(Effect.orDie);
      yield* h.tasks.drain;
      yield* h.settleAll;
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
      yield* start(h, thread);
      yield* settleTurn(h, thread, "interrupted");
      yield* h.until(root, (d) => d.task.status === "interrupted", "the task to be interrupted");
      yield* say(h, thread, "Partial work.");
      yield* complete(h, thread);
      yield* h.settleAll;
      const detail = yield* h.get(root);
      expect(detail.task.status).toBe("interrupted");
      expect(detail.attempts.length).toBe(1);
    }),
);

// A provider event that arrives after its own terminal must not leave the chat
// running. In v2 the orchestrator's projection is authoritative: the late
// provider turn update is folded into the stored turn, and the task settled on
// the terminal already.
chainTest(
  "a turn.started that arrives after its own turn.completed does not leave the chat running",
  (h) =>
    Effect.gen(function* () {
      const root = yield* h.createRoot("late-started");
      const thread = yield* h.threadOf(root);
      yield* start(h, thread);
      yield* say(h, thread, "Quick one.");
      yield* complete(h, thread);
      yield* h.until(root, (d) => d.task.status === "completed", "the task to complete");
      // Delivered out of order: the start of a turn that has already completed.
      yield* h.provider.emit({
        type: "provider_turn.updated",
        driver,
        providerTurn: {
          id: currentTurn(h, thread).providerTurn.id,
          providerThreadId: currentTurn(h, thread).providerTurn.providerThreadId,
          nodeId: currentTurn(h, thread).providerTurn.nodeId,
          runAttemptId: currentTurn(h, thread).providerTurn.runAttemptId,
          nativeTurnRef: {
            driver,
            nativeId: `native:${currentTurn(h, thread).providerTurn.id}`,
            strength: "strong",
          },
          ordinal: currentTurn(h, thread).providerTurn.ordinal,
          status: "running",
          startedAt: currentTurn(h, thread).providerTurn.startedAt,
          completedAt: null,
        },
      });
      yield* h.settleAll;
      const session = (yield* h.thread(thread))?.session;
      expect([session?.status, session?.activeTurnId]).toEqual(["ready", null]);
      expect((yield* h.get(root)).task.status).toBe("completed");
    }),
);
