// What the orchestrator does with a task steer that is not delivered into the
// running turn, and what cancelling the task must therefore remove.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { personalTaskSteerMessageId } from "../personalThreadTitles.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:task-steer-queue");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "task-steer-queue" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const startTaskThreadWithSteer = (threadId: ThreadId, steerId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    const send = (messageId: MessageId, text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${messageId}`),
        threadId,
        messageId,
        text,
        attachments: [],
        // PersonalEngineV2Live maps a task steer sent with mode "start" to this.
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      });
    yield* send(MessageId.make(`personal-task-${threadId}-1`), "the task's turn");
    yield* send(personalTaskSteerMessageId(steerId), "Update from CTO: only the login page.");
  });

const runStates = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`);
  });

const interrupt = (threadId: ThreadId, tag: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.interruptThread({
      projectId,
      commandId: CommandId.make(`interrupt:${tag}`),
      threadId,
      reason: "Stopped by the personal layer",
    });
  });

it.effect(
  "a steer sent as a start queues behind the task's turn, and interrupting the turn leaves it queued to run",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:steer-queued");
      yield* startTaskThreadWithSteer(threadId, "abc");
      assert.deepEqual(yield* runStates(threadId), ["starting", "queued"]);
      yield* interrupt(threadId, "leaves-queued");
      const states = yield* runStates(threadId);
      assert.notInclude(states[0]!, "starting");
      // Not held and not cancelled: the queue drains into a new run.
      assert.strictEqual(states[1], "queued");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "cancelling the queued steer first leaves nothing that can start after the interrupt",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:steer-cancelled");
      yield* startTaskThreadWithSteer(threadId, "def");
      const steerMessage = personalTaskSteerMessageId("def");
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "queued" && run.userMessageId === steerMessage,
      )!;
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("cancel:steer-cancelled"),
        threadId,
        runId: queued.id,
      });
      yield* interrupt(threadId, "after-cancel");
      const states = yield* runStates(threadId);
      assert.isFalse(states.some((state) => state.startsWith("queued")));
      assert.isFalse(states.slice(1).some((state) => state === "starting" || state === "running"));
    }).pipe(Effect.provide(layerTest)),
);
