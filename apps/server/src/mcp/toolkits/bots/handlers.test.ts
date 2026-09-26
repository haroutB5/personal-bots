import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  PersonalBotId,
  PersonalGroupId,
  PersonalGroupVoteId,
  ProviderInstanceId,
  ThreadId,
  type PersonalBrowserStatus,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "../../../persistence/Services/ProjectionThreadMessages.ts";
import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as PersonalBrowser from "../../../personal/browser/PersonalBrowser.ts";
import * as PersonalGroupRepository from "../../../personal/groups/PersonalGroupRepository.ts";
import * as PersonalGroupService from "../../../personal/groups/PersonalGroupService.ts";
import * as PersonalBotService from "../../../personal/PersonalBotService.ts";
import * as PersonalSecretService from "../../../personal/secrets/PersonalSecretService.ts";
import * as PersonalLoginService from "../../../personal/secrets/PersonalLoginService.ts";
import * as PersonalTaskRepository from "../../../personal/tasks/PersonalTaskRepository.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import { HostOperationError } from "../../../personal/browser/pageOperations.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { personalTaskMessageId } from "../../../personal/personalThreadTitles.ts";
import {
  BotsToolkitHandlersLive,
  DELEGATE_NOTE,
  messageNamesBot,
  shortenBrowserHelpReason,
} from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const CALLER_THREAD = ThreadId.make("thread-assistant");
const STRANGER_THREAD = ThreadId.make("thread-not-personal");
const TURN = TurnId.make("turn-1");

const botId = (key: string) => PersonalBotId.make(`bot-${key}`);

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly sessions: Map<string, OrchestrationSession>;
  readonly loginUses: Array<{ readonly threadId: string; readonly labelOrOrigin: string }>;
  readonly browserHelpRequests: Array<{
    readonly threadId: ThreadId;
    readonly reason: string;
  }>;
  /** A thread's messages as the tools read them, oldest first. */
  readonly messages: Map<string, Array<{ messageId: string; role: string; text: string }>>;
  /** The shared browser as the tools see it: current state, and what closed it. */
  readonly browser: {
    state: PersonalBrowserStatus["state"];
    controller: PersonalBrowserStatus["controller"];
    readonly closes: Array<ThreadId | null>;
    /** Fires as the handler reads the status; lets a test land a takeover there. */
    onStatusRead: (() => void) | null;
  };
}

const browserStatus = (harness: Harness): PersonalBrowserStatus => ({
  state: harness.browser.state,
  detail: null,
  lockedByPid: null,
  controller: harness.browser.controller,
  generation: 1,
  page: null,
  helpRequest: null,
  lastAgent: null,
  viewers: 0,
});

const makeLayer = (harness: Harness) =>
  PersonalSecretService.layerLive.pipe(
    Layer.provideMerge(
      Layer.mock(PersonalBrowser.PersonalBrowser)({
        status: () =>
          Effect.sync(() => {
            const snapshot = browserStatus(harness);
            harness.browser.onStatusRead?.();
            return snapshot;
          }),
        requestHelp: (input) =>
          Effect.sync(() => {
            harness.browserHelpRequests.push({ threadId: input.threadId, reason: input.reason });
            return {
              threadId: input.threadId,
              botId: input.botId,
              botName: input.botName,
              reason: input.reason,
              requestedAt: "2026-09-15T10:00:00.000Z",
            };
          }),
        // The real service re-checks human control inside the lease lock, so a
        // takeover that lands after the handler's read still refuses the close.
        closeBrowser: (input) =>
          Effect.suspend(() =>
            harness.browser.controller._tag === "Human"
              ? Effect.fail(
                  new HostOperationError(
                    "PreviewAutomationControlInterruptedError",
                    "The user has taken control of the shared browser.",
                  ),
                )
              : Effect.sync(() => {
                  harness.browser.closes.push(input.byThreadId);
                  harness.browser.state = "offline";
                  harness.browser.controller = { _tag: "None" };
                  return browserStatus(harness);
                }),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(PersonalLoginService.PersonalLoginService)({
        use: (input) =>
          Effect.sync(() => {
            harness.loginUses.push(input);
            return { success: true as const, filled: ["username", "password"] as const };
          }),
      }),
    ),
    Layer.provideMerge(PersonalTaskService.layer),
    Layer.provideMerge(PersonalTaskRepository.layer),
    // The real group service, not a mock: call_vote and cast_vote are thin
    // wrappers, so a mock would test the wrapper and nothing that matters.
    // `layerLive` brings its own repository and message reader over the same
    // in-memory SQLite, so it reads back what it wrote.
    Layer.provideMerge(PersonalGroupService.layerLive),
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
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
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() => {
            const session = harness.sessions.get(threadId);
            return session === undefined
              ? Option.none()
              : Option.some({ id: threadId, session, latestTurn: null });
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
          Effect.sync(() => harness.messages.get(threadId) ?? []),
      } as unknown as ProjectionThreadMessageRepositoryShape),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-toolkit-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const runningSession = (threadId: ThreadId): OrchestrationSession => ({
  threadId,
  status: "running",
  providerName: "claudeAgent",
  runtimeMode: "full-access",
  activeTurnId: TURN,
  lastError: null,
  updatedAt: "2026-09-13T00:00:00.000Z",
});

const invocation = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

/** Seeds four bots, links CALLER_THREAD to the assistant and marks its turn running. */
const setup = (harness: Harness) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotService.PersonalBotService;
    for (const key of ["assistant", "developer", "researcher", "planner"]) {
      yield* bots.create({
        botId: botId(key),
        name: key[0]!.toUpperCase() + key.slice(1),
        description: `${key} bot`,
        instructions: "",
        avatarShape: "blob",
        avatarColor: "#1A73E8",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
      });
    }
    yield* bots.createThread({ botId: botId("assistant"), threadId: CALLER_THREAD });
    harness.sessions.set(CALLER_THREAD, runningSession(CALLER_THREAD));
    harness.sessions.set(STRANGER_THREAD, runningSession(STRANGER_THREAD));

    const toolkit = yield* BotsToolkit.pipe(Effect.provide(BotsToolkitHandlersLive));
    const call = <Name extends keyof typeof BotsToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
      options: {
        readonly threadId?: ThreadId;
        readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
      } = {},
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof BotsToolkit.tools)[Name]>,
        ),
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(options.threadId ?? CALLER_THREAD, options.capabilities ?? ["bots"]),
        ),
      );
    return { call };
  });

const withHarness = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeLayer>>>,
) => {
  const harness: Harness = {
    dispatched: [],
    sessions: new Map(),
    loginUses: [],
    browserHelpRequests: [],
    messages: new Map(),
    browser: {
      state: "connected",
      controller: { _tag: "None" },
      closes: [],
      onStatusRead: null,
    },
  };
  return body(harness).pipe(Effect.provide(makeLayer(harness)));
};

describe("bots toolkit handlers", () => {
  it.effect("refuses a credential without the bots capability", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const error = yield* call("list_bots", {}, { capabilities: ["pull-requests"] }).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({
          _tag: "McpCapabilityUnavailableError",
          capability: "bots",
          threadId: CALLER_THREAD,
        });
      }),
    ),
  );

  it.effect("list_bots returns enabled bots and marks the caller", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const bots = yield* PersonalBotService.PersonalBotService;
        yield* bots.update({ botId: botId("planner"), enabled: false });

        const result = yield* call("list_bots", {});

        expect(result.bots.map((bot) => [bot.name, bot.isYou])).toEqual([
          ["Assistant", true],
          ["Developer", false],
          ["Researcher", false],
        ]);
        expect(result.bots[1]).toMatchObject({ provider: "codex", model: "gpt-test" });
      }),
    ),
  );

  it.effect("delegate_task creates exactly one child per turn, target and objective", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const tasks = yield* PersonalTaskService.PersonalTaskService;
        const input = { targetBot: "developer", objective: "Write the migration." };

        const first = yield* call("delegate_task", input);
        const again = yield* call("delegate_task", input);
        // The same target by id is the same delegation too.
        const byId = yield* call("delegate_task", { ...input, targetBot: botId("developer") });
        yield* tasks.drain;

        expect(first.note).toBe(DELEGATE_NOTE);
        expect(again.childTaskId).toBe(first.childTaskId);
        expect(byId.childTaskId).toBe(first.childTaskId);

        const other = yield* call("delegate_task", {
          targetBot: "Researcher",
          objective: "Compare two ORMs.",
        });
        expect(other.childTaskId).not.toBe(first.childTaskId);

        // The caller had no task: its running turn was adopted as a root.
        const listed = yield* call("list_tasks", {});
        const root = listed.tasks.find((task) => task.parentTaskId === null)!;
        expect(listed.tasks.length).toBe(3);
        expect(root).toMatchObject({ botId: botId("assistant"), status: "running" });
        const rootTask = (yield* tasks.get({ taskId: root.taskId as never })).task;
        expect(rootTask).toMatchObject({ source: "user", threadId: CALLER_THREAD });
        expect(
          listed.tasks.filter((task) => task.parentTaskId === root.taskId).map((t) => t.taskId),
        ).toEqual(expect.arrayContaining([first.childTaskId, other.childTaskId]));
      }),
    ),
  );

  it.effect("refuses a thread that is not a personal bot's, even with the capability", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const error = yield* call(
          "delegate_task",
          { targetBot: "developer", objective: "Anything." },
          { threadId: STRANGER_THREAD },
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "BotsToolError" });
        expect(error.message).toContain("does not belong to a personal bot");
      }),
    ),
  );

  it.effect("get_task and list_tasks stay inside the caller's task tree", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const tasks = yield* PersonalTaskService.PersonalTaskService;
        const child = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Fix the build.",
        });
        const unrelated = yield* tasks.createTask({
          idempotencyKey: "unrelated-root",
          botId: botId("researcher"),
          title: "Someone else's request",
          objective: "Research something else.",
        });
        yield* tasks.drain;

        const own = yield* call("get_task", { taskId: child.childTaskId as never });
        expect(own.task).toMatchObject({ taskId: child.childTaskId, botName: "Developer" });

        const outside = yield* call("get_task", { taskId: unrelated.taskId }).pipe(Effect.flip);
        expect(outside.message).toBe("That task is not in your task tree.");

        const listed = yield* call("list_tasks", {});
        expect(listed.tasks.map((task) => task.taskId)).not.toContain(unrelated.taskId);
      }),
    ),
  );

  it.effect("stop_task cancels a delegated task the caller owns", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const child = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Fix the build.",
        });
        yield* (yield* PersonalTaskService.PersonalTaskService).drain;

        const stopped = yield* call("stop_task", {
          taskId: child.childTaskId as never,
          reason: "The requirements changed.",
        });

        expect(stopped.status).toBe("cancelled");
        const after = yield* call("get_task", { taskId: child.childTaskId as never });
        expect(after.task.status).toBe("cancelled");
      }),
    ),
  );

  it.effect("stop_task refuses a task outside the caller's tree", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const tasks = yield* PersonalTaskService.PersonalTaskService;
        const unrelated = yield* tasks.createTask({
          idempotencyKey: "unrelated-stop",
          botId: botId("researcher"),
          title: "Someone else's request",
          objective: "Research something else.",
        });
        yield* tasks.drain;

        const outside = yield* call("stop_task", {
          taskId: unrelated.taskId,
          reason: "Not mine to stop.",
        }).pipe(Effect.flip);

        expect(outside.message).toBe("That task is not in your task tree.");
      }),
    ),
  );

  it.effect("stop_task redirects to a fresh task when given a new objective", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const child = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Draw the arrows.",
        });
        yield* (yield* PersonalTaskService.PersonalTaskService).drain;

        const redirected = yield* call("stop_task", {
          taskId: child.childTaskId as never,
          reason: "Shape changed.",
          redirectObjective: "Draw circles instead.",
        });

        expect(redirected.status).toBe("cancelled");
        expect(redirected.redirectedTaskId).not.toBeNull();
        expect(redirected.redirectedTaskId).not.toBe(child.childTaskId);

        const replacement = yield* call("get_task", {
          taskId: redirected.redirectedTaskId as never,
        });
        expect(replacement.task.botName).toBe("Developer");
        expect(replacement.task.status).not.toBe("cancelled");
      }),
    ),
  );

  /** A task a routine started for `bot`, running on its own thread: another request tree. */
  const routineTask = (harness: Harness, bot: string, key: string) =>
    Effect.gen(function* () {
      const tasks = yield* PersonalTaskService.PersonalTaskService;
      const created = yield* tasks.createTask({
        idempotencyKey: `routine:${key}`,
        botId: botId(bot),
        title: "Nightly QA pass",
        objective: "Check every page.",
        source: "routine",
      });
      yield* tasks.drain;
      const task = (yield* tasks.get({ taskId: created.taskId })).task;
      expect(task.status).toBe("running");
      harness.sessions.set(task.threadId!, runningSession(task.threadId!));
      return task;
    });

  const makeAssistantLead = Effect.gen(function* () {
    const bots = yield* PersonalBotService.PersonalBotService;
    yield* bots.update({ botId: botId("assistant"), lead: true });
  });

  it.effect("steer_task steers a task the caller delegated and records it on the task", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const tasks = yield* PersonalTaskService.PersonalTaskService;
        const child = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Fix the build.",
        });
        yield* tasks.drain;
        const childTask = (yield* tasks.get({ taskId: child.childTaskId as never })).task;
        harness.sessions.set(childTask.threadId!, runningSession(childTask.threadId!));

        const steered = yield* call("steer_task", {
          taskId: child.childTaskId as never,
          message: "Only the server package.",
        });

        expect(steered).toMatchObject({ outcome: "steered", status: "running" });
        const turn = harness.dispatched.at(-1)!;
        expect(turn).toMatchObject({
          type: "thread.turn.start",
          threadId: childTask.threadId,
          modelSelection: { instanceId: "codex", model: "gpt-test" },
          message: { text: "Update from Assistant: Only the server package." },
        });
        const after = yield* call("get_task", { taskId: child.childTaskId as never });
        expect(after.task.status).toBe("running");
        expect(after.steers).toEqual([
          expect.objectContaining({
            text: "Update from Assistant: Only the server package.",
            delivered: true,
          }),
        ]);
      }),
    ),
  );

  it.effect("steer_task refuses a finished task", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const child = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Fix the build.",
        });
        yield* (yield* PersonalTaskService.PersonalTaskService).drain;
        yield* call("stop_task", { taskId: child.childTaskId as never, reason: "Done." });
        const before = harness.dispatched.length;

        const error = yield* call("steer_task", {
          taskId: child.childTaskId as never,
          message: "One more thing.",
        }).pipe(Effect.flip);

        expect(error.message).toContain("already cancelled");
        expect(harness.dispatched.length).toBe(before);
      }),
    ),
  );

  it.effect("a team lead can read, steer and stop a team task a routine started", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        yield* makeAssistantLead;
        const task = yield* routineTask(harness, "researcher", "lead-reach");

        const read = yield* call("get_task", { taskId: task.taskId });
        expect(read.task).toMatchObject({ taskId: task.taskId, botName: "Researcher" });
        const listed = yield* call("list_tasks", {});
        expect(listed.teamTasks.map((entry) => entry.taskId)).toContain(task.taskId);
        expect(listed.tasks.map((entry) => entry.taskId)).not.toContain(task.taskId);

        const steered = yield* call("steer_task", {
          taskId: task.taskId,
          message: "Narrow it to the login page.",
        });
        expect(steered.outcome).toBe("steered");
        expect(harness.dispatched.at(-1)).toMatchObject({
          type: "thread.turn.start",
          threadId: task.threadId,
          message: { text: "Update from Assistant: Narrow it to the login page." },
        });

        const stopped = yield* call("stop_task", {
          taskId: task.taskId,
          reason: "Superseded.",
        });
        expect(stopped.status).toBe("cancelled");
      }),
    ),
  );

  it.effect("a bot that is not a lead cannot reach a team task outside its tree", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const task = yield* routineTask(harness, "researcher", "no-lead");
        const before = harness.dispatched.length;

        for (const refused of [
          Effect.flip(call("get_task", { taskId: task.taskId })),
          Effect.flip(call("steer_task", { taskId: task.taskId, message: "Narrow it." })),
          Effect.flip(call("stop_task", { taskId: task.taskId, reason: "Not mine." })),
        ]) {
          const error = yield* refused;
          expect(error.message).toBe("That task is not in your task tree.");
        }
        expect((yield* call("list_tasks", {})).teamTasks).toEqual([]);
        expect(harness.dispatched.length).toBe(before);
      }),
    ),
  );

  it.effect("a team lead cannot reach another team's task", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        yield* makeAssistantLead;
        const bots = yield* PersonalBotService.PersonalBotService;
        yield* bots.update({ botId: botId("developer"), team: "dev", lead: true });
        const task = yield* routineTask(harness, "developer", "other-team");
        const before = harness.dispatched.length;

        for (const refused of [
          Effect.flip(call("get_task", { taskId: task.taskId })),
          Effect.flip(call("steer_task", { taskId: task.taskId, message: "Narrow it." })),
          Effect.flip(call("stop_task", { taskId: task.taskId, reason: "Not mine." })),
        ]) {
          const error = yield* refused;
          expect(error.message).toBe("That task is not in your task tree.");
        }
        const listed = yield* call("list_tasks", {});
        expect(listed.teamTasks.map((entry) => entry.taskId)).not.toContain(task.taskId);
        expect(harness.dispatched.length).toBe(before);
      }),
    ),
  );

  it.effect("delegation refusals come back as readable tool errors", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const self = yield* call("delegate_task", {
          targetBot: "assistant",
          objective: "Do it yourself.",
        }).pipe(Effect.flip);
        expect(self.message).toBe("You cannot delegate a task to yourself.");

        const unknown = yield* call("delegate_task", {
          targetBot: "Nobody",
          objective: "Anything.",
        }).pipe(Effect.flip);
        expect(unknown.message).toContain("No enabled bot is called 'Nobody'");
        expect(unknown.message).toContain("Developer");

        // Default root limit is 4 delegated tasks; the fifth is refused.
        for (const objective of ["one", "two", "three", "four"]) {
          yield* call("delegate_task", { targetBot: "developer", objective });
        }
        const limited = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "five",
        }).pipe(Effect.flip);
        expect(limited.message).toContain("Delegation limit reached");
      }),
    ),
  );

  // The owner's bots are split in two: a dev team its lead runs, and the
  // assistant's. A bot sees and reaches its own team only — unless the owner
  // themselves names someone on the other one.
  const moveDeveloperToDevTeam = Effect.gen(function* () {
    const bots = yield* PersonalBotService.PersonalBotService;
    yield* bots.update({ botId: botId("developer"), team: "dev", lead: true });
  });

  it.effect("list_bots shows the caller's own team and hides the other one", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        yield* moveDeveloperToDevTeam;

        const result = yield* call("list_bots", {});

        expect(result.bots.map((bot) => bot.name)).toEqual(["Assistant", "Researcher", "Planner"]);
      }),
    ),
  );

  it.effect("delegate_task refuses the other team and says how to unblock it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        yield* moveDeveloperToDevTeam;

        const error = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Write the migration.",
        }).pipe(Effect.flip);

        expect(error.message).toContain("Dev team");
        expect(error.message).toContain("ask them to request it");
        // It is told who it *can* ask instead.
        expect(error.message).toContain("Researcher");
      }),
    ),
  );

  it.effect("custom teams preserve delegation boundaries and display their name", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const bots = yield* PersonalBotService.PersonalBotService;
        // A custom team exists because the owner registered it; `update` now
        // refuses a team that is not a built-in or a registered custom team.
        yield* bots.setProfile({ teamChange: { operation: "create", name: "Research" } });
        yield* bots.update({ botId: botId("developer"), team: "Research" });
        const listed = yield* call("list_bots", {});
        expect(listed.bots.map((bot) => bot.name)).not.toContain("Developer");
        const error = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Investigate.",
        }).pipe(Effect.flip);
        expect(error.message).toContain("Research");
      }),
    ),
  );

  it.effect("delegate_task crosses teams when the owner's latest message names the bot", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        yield* moveDeveloperToDevTeam;
        harness.messages.set(CALLER_THREAD, [
          { messageId: "msg-1", role: "user", text: "Ask Developer to write the migration." },
        ]);

        const child = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Write the migration.",
        });

        expect(child.targetBotId).toBe(botId("developer"));
      }),
    ),
  );

  // A delegation brief is written by the task service, on a `personal-task-`
  // id. If that counted as the owner speaking, a bot could widen its own reach
  // just by writing another bot's name into a brief.
  it.effect("a task-service turn message naming the bot does not open the other team", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        yield* moveDeveloperToDevTeam;
        harness.messages.set(CALLER_THREAD, [
          { messageId: "msg-1", role: "user", text: "Please sort out the release." },
          {
            messageId: personalTaskMessageId("task-1", 1),
            role: "user",
            text: "Delegate this to Developer.",
          },
        ]);

        const error = yield* call("delegate_task", {
          targetBot: "developer",
          objective: "Write the migration.",
        }).pipe(Effect.flip);

        expect(error.message).toContain("not yours");
      }),
    ),
  );

  it("names a bot only as a whole word, by name or id", () => {
    const developer = { botId: "bot-developer", name: "Developer" };
    expect(messageNamesBot("ask developer to do it", developer)).toBe(true);
    expect(messageNamesBot("hand it to bot-developer", developer)).toBe(true);
    expect(messageNamesBot("our developers are busy", developer)).toBe(false);
    expect(messageNamesBot("redeveloper", developer)).toBe(false);
  });

  it.effect("use_login returns only status and filled fields", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const result = yield* call("use_login", { login: "Example" });

        // No grant is consulted: every bot shares every saved login.
        expect(harness.loginUses).toEqual([{ threadId: CALLER_THREAD, labelOrOrigin: "Example" }]);
        expect(result).toEqual({ success: true, filled: ["username", "password"] });
        expect(Object.keys(result).toSorted()).toEqual(["filled", "success"]);
      }),
    ),
  );

  it.effect("close_browser closes the shared browser once and says so", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const first = yield* call("close_browser", {});
        expect(first.closed).toBe(true);
        expect(harness.browser.closes).toEqual([CALLER_THREAD]);

        // Already closed: still safe to call, and the model is told nothing
        // happened rather than being left to guess.
        const second = yield* call("close_browser", {});
        expect(second.closed).toBe(false);
        expect(second.note).toContain("already closed");
      }),
    ),
  );

  it.effect("request_browser_help records a short request for the calling thread", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const result = yield* call("request_browser_help", {
          reason: "CAPTCHA on amazon.co.uk",
        });

        expect(result.requested).toBe(true);
        expect(result.note).toContain("end your turn");
        expect(harness.browserHelpRequests).toEqual([
          { threadId: CALLER_THREAD, reason: "CAPTCHA on amazon.co.uk" },
        ]);
      }),
    ),
  );

  // Live 2026-09-15: a bot the egress guard had just paused wrote a long reason,
  // got "Expected a value with a length of at most 160" and told the user the
  // error did not say why. The call goes through the tool's own schema here.
  it.effect("request_browser_help accepts a long reason and stores it cut to 160", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const reason = `${"word ".repeat(80).trim()}x`;
        expect(reason).toHaveLength(400);

        const result = yield* call("request_browser_help", { reason });

        expect(result.requested).toBe(true);
        const stored = harness.browserHelpRequests[0]?.reason ?? "";
        expect(Array.from(stored)).toHaveLength(160);
        expect(stored.endsWith("word…")).toBe(true);
        expect(reason.startsWith(stored.slice(0, -1))).toBe(true);
      }),
    ),
  );

  it("shortens a help reason to one line without splitting a character", () => {
    expect(shortenBrowserHelpReason("CAPTCHA on amazon.co.uk")).toBe("CAPTCHA on amazon.co.uk");
    expect(shortenBrowserHelpReason("Paused:\n  send  this\tthere ")).toBe(
      "Paused: send this there",
    );
    const emoji = shortenBrowserHelpReason("🔒".repeat(200));
    expect(Array.from(emoji)).toHaveLength(160);
    expect(emoji).toBe(`${"🔒".repeat(159)}…`);
  });

  // Audit #6: the handler's own read cannot be the authorization. A takeover
  // that lands after it must still leave the browser open.
  it.effect("close_browser reports a takeover that lands after its status read", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        // The user takes control in the window between the read and the close.
        harness.browser.onStatusRead = () => {
          harness.browser.controller = { _tag: "Human", self: false, connected: true };
          harness.browser.onStatusRead = null;
        };

        const error = yield* call("close_browser", {}).pipe(Effect.flip);

        expect(error.message).toContain("The browser was not closed");
        expect(error.message).toContain("taken control");
        expect(harness.browser.closes).toEqual([]);
      }),
    ),
  );

  it.effect("close_browser refuses while the user is controlling the browser", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        harness.browser.controller = { _tag: "Human", self: false, connected: true };

        const error = yield* call("close_browser", {}).pipe(Effect.flip);

        expect(error.message).toContain("The user is using the browser");
        expect(harness.browser.closes).toEqual([]);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Group voting (addendum section V). The real PersonalGroupService runs here,
// so "refuses outside a group round" is proved against the same query that
// decides it in production rather than against a stub.
// ---------------------------------------------------------------------------

const GROUP = PersonalGroupId.make("group-vote");
const GROUP_THREAD = ThreadId.make("thread-group-vote");

/**
 * Opens a group round and returns the thread of the member now speaking - the
 * only place from which a vote can be called. That thread is a real bot thread
 * (the group service created it), so `callerBot()` resolves it the same way it
 * resolves any other chat.
 */
const speakingInGroup = (members: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const groups = yield* PersonalGroupService.PersonalGroupService;
    const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
    yield* groups.create({
      groupId: GROUP,
      threadId: GROUP_THREAD,
      name: "Launch crew",
      botIds: members.map(botId),
    });
    yield* groups.sendMessage({
      groupId: GROUP,
      messageId: MessageId.make("group-msg-1"),
      text: "what do we do about the release?",
    });
    yield* groups.drain;
    const round = yield* repository.latestRoundForGroup(GROUP);
    const speaking = Option.isSome(round) ? round.value.activeThreadId : null;
    if (speaking === null) {
      throw new Error("no member is speaking in the group round");
    }
    return speaking;
  });

describe("bots toolkit voting", () => {
  it.effect("call_vote and cast_vote are refused outside a group round", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        // CALLER_THREAD is an ordinary one-to-one bot chat: a real thread, a
        // real bot, no round. Test 17.
        const called = yield* call("call_vote", {
          question: "Ship on Friday?",
          options: ["ship", "wait"],
        }).pipe(Effect.flip);
        expect(called.message).toContain("not speaking in a group chat");

        const cast = yield* call("cast_vote", {
          voteId: PersonalGroupVoteId.make("vote-nope"),
          option: "ship",
          reason: "because",
        }).pipe(Effect.flip);
        expect(cast.message).toContain("not speaking in a group chat");
      }),
    ),
  );

  it.effect("delegate_task is refused from a group member's turn", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const tasks = yield* PersonalTaskService.PersonalTaskService;
        const threadId = yield* speakingInGroup(["assistant", "developer"]);
        // The member turn is the round's. Adopting it as a task would bring
        // the child's answer back as a hidden turn no round knows about.
        const refused = yield* call(
          "delegate_task",
          { targetBot: "developer", objective: "Write the migration." },
          { threadId },
        ).pipe(Effect.flip);
        expect(refused.message).toContain("Launch crew");
        const listed = yield* tasks.list({});
        expect(listed.tasks).toEqual([]);
      }),
    ),
  );

  it.effect("call_vote opens one vote, names the voters, and announces it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const threadId = yield* speakingInGroup(["assistant", "developer", "researcher"]);

        const opened = yield* call(
          "call_vote",
          { question: "Ship on Friday?", options: ["ship", "wait"] },
          { threadId },
        );

        expect(opened.voteId).toMatch(/^vote-[0-9a-f]{12}$/);
        expect(opened.options).toEqual(["ship", "wait"]);
        // Everyone may ballot, the caller included - it just gets no extra
        // turn for having asked.
        expect([...opened.voters].sort()).toEqual(["Assistant", "Developer", "Researcher"]);
        // The vote id reaches the other members through the transcript, which
        // is the only channel they read.
        const announced = harness.dispatched.filter(
          (command) =>
            command.type === "thread.message.assistant.delta" &&
            command.threadId === GROUP_THREAD &&
            command.delta.includes(opened.voteId),
        );
        expect(announced.length).toBe(1);
      }),
    ),
  );

  it.effect("a second call_vote while one is open is refused, naming the open vote", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const threadId = yield* speakingInGroup(["assistant", "developer"]);
        const opened = yield* call(
          "call_vote",
          { question: "Ship on Friday?", options: ["ship", "wait"] },
          { threadId },
        );

        // Test 18. A different question, so only the open-vote rail can refuse it.
        const second = yield* call(
          "call_vote",
          { question: "Which database?", options: ["postgres", "sqlite"] },
          { threadId },
        ).pipe(Effect.flip);

        expect(second.message).toContain("already open");
        expect(second.message).toContain(opened.voteId);
        expect(second.message).toContain("Ship on Friday?");
      }),
    ),
  );

  it.effect("one ballot per bot: the second is refused and changes nothing", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const threadId = yield* speakingInGroup(["assistant", "developer"]);
        const opened = yield* call(
          "call_vote",
          { question: "Ship on Friday?", options: ["ship", "wait"] },
          { threadId },
        );

        const first = yield* call(
          "cast_vote",
          {
            voteId: PersonalGroupVoteId.make(opened.voteId),
            option: "ship",
            reason: "it is ready",
          },
          { threadId },
        );
        expect(first).toMatchObject({ option: "ship", status: "open", ballotsCast: 1 });

        // Test 19: a second ballot from the same bot is refused outright...
        const again = yield* call(
          "cast_vote",
          {
            voteId: PersonalGroupVoteId.make(opened.voteId),
            option: "wait",
            reason: "changed my mind",
          },
          { threadId },
        ).pipe(Effect.flip);
        expect(again.message).toContain("already voted");

        // ...and the first ballot still stands, unchanged.
        const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
        const vote = yield* repository.getVote(PersonalGroupVoteId.make(opened.voteId));
        expect(Option.isSome(vote) ? vote.value.ballots : []).toMatchObject([
          { botId: botId("assistant"), option: "ship", reason: "it is ready" },
        ]);
      }),
    ),
  );

  it.effect("a ballot for an option that is not on the paper is refused", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const threadId = yield* speakingInGroup(["assistant", "developer"]);
        const opened = yield* call(
          "call_vote",
          { question: "Ship on Friday?", options: ["ship", "wait"] },
          { threadId },
        );

        const error = yield* call(
          "cast_vote",
          {
            voteId: PersonalGroupVoteId.make(opened.voteId),
            option: "ship it on Monday",
            reason: "compromise",
          },
          { threadId },
        ).pipe(Effect.flip);

        expect(error.message).toContain("not on this ballot");
        expect(error.message).toContain("ship, wait");
      }),
    ),
  );

  it.effect("a question the round already decided cannot be re-asked, reworded", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        // One member, so its own ballot is the last one and the vote resolves
        // inside this turn - the shortest path to a DECIDED question.
        const threadId = yield* speakingInGroup(["assistant"]);
        const opened = yield* call(
          "call_vote",
          { question: "Should we ship on Friday?", options: ["ship", "wait"] },
          { threadId },
        );
        const cast = yield* call(
          "cast_vote",
          {
            voteId: PersonalGroupVoteId.make(opened.voteId),
            option: "ship",
            reason: "it is ready",
          },
          { threadId },
        );
        expect(cast.status).toBe("decided");

        // Test 21: same question, different words, different order.
        const reAsked = yield* call(
          "call_vote",
          { question: "Friday - do we ship?", options: ["ship", "wait"] },
          { threadId },
        ).pipe(Effect.flip);
        expect(reAsked.message).toContain("already voted on that");
        expect(reAsked.message).toContain("Should we ship on Friday?");

        // A genuinely different question is still allowed.
        const other = yield* call(
          "call_vote",
          { question: "Which database do we use?", options: ["postgres", "sqlite"] },
          { threadId },
        );
        expect(other.voteId).not.toBe(opened.voteId);
      }),
    ),
  );

  it.effect("a vote needs at least two distinct options", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const threadId = yield* speakingInGroup(["assistant", "developer"]);

        const error = yield* call(
          "call_vote",
          // The same answer twice is one answer, so this is not a vote.
          { question: "Ship on Friday?", options: ["ship", " ship "] },
          { threadId },
        ).pipe(Effect.flip);

        expect(error.message).toContain("at least 2 different options");
      }),
    ),
  );
});
