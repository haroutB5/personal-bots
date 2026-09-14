import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PersonalBotId,
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
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "../../../persistence/Services/ProjectionThreadMessages.ts";
import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as PersonalBrowser from "../../../personal/browser/PersonalBrowser.ts";
import * as PersonalBotService from "../../../personal/PersonalBotService.ts";
import * as PersonalSecretService from "../../../personal/secrets/PersonalSecretService.ts";
import * as PersonalLoginService from "../../../personal/secrets/PersonalLoginService.ts";
import * as PersonalTaskRepository from "../../../personal/tasks/PersonalTaskRepository.ts";
import * as PersonalTaskService from "../../../personal/tasks/PersonalTaskService.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BotsToolkitHandlersLive, DELEGATE_NOTE } from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const CALLER_THREAD = ThreadId.make("thread-assistant");
const STRANGER_THREAD = ThreadId.make("thread-not-personal");
const TURN = TurnId.make("turn-1");

const botId = (key: string) => PersonalBotId.make(`bot-${key}`);

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly sessions: Map<string, OrchestrationSession>;
  readonly loginUses: Array<{
    readonly botId: string;
    readonly threadId: string;
    readonly labelOrOrigin: string;
  }>;
  /** The shared browser as the tools see it: current state, and what closed it. */
  readonly browser: {
    state: PersonalBrowserStatus["state"];
    controller: PersonalBrowserStatus["controller"];
    readonly closes: Array<ThreadId | null>;
  };
}

const browserStatus = (harness: Harness): PersonalBrowserStatus => ({
  state: harness.browser.state,
  detail: null,
  lockedByPid: null,
  controller: harness.browser.controller,
  generation: 1,
  page: null,
  viewers: 0,
});

const makeLayer = (harness: Harness) =>
  PersonalSecretService.layerLive.pipe(
    Layer.provideMerge(
      Layer.mock(PersonalBrowser.PersonalBrowser)({
        status: () => Effect.sync(() => browserStatus(harness)),
        closeBrowser: (input) =>
          Effect.sync(() => {
            harness.browser.closes.push(input.byThreadId);
            harness.browser.state = "offline";
            harness.browser.controller = { _tag: "None" };
            return browserStatus(harness);
          }),
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
        listByThreadId: () => Effect.succeed([]),
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
    browser: { state: "connected", controller: { _tag: "None" }, closes: [] },
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

  it.effect("use_login returns only status and filled fields", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const { call } = yield* setup(harness);
        const result = yield* call("use_login", { login: "Example" });

        expect(harness.loginUses).toEqual([
          { botId: botId("assistant"), threadId: CALLER_THREAD, labelOrOrigin: "Example" },
        ]);
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
