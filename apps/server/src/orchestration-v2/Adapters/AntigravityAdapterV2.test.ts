import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatFileAttachment,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ECO_ACP_HANDOFF_PLANNER_ACK } from "@t3tools/provider-core/server/ecoGuard";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } from "../../provider/antigravityAuthSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  type AntigravityAdapterV2RuntimeInput,
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("defers MCP tools by default and honors T3CODE_PERSONAL_MCP_DEFER=off", () => {
    const previous = process.env.T3CODE_PERSONAL_MCP_DEFER;
    try {
      delete process.env.T3CODE_PERSONAL_MCP_DEFER;
      assert.isTrue(flavor.deferMcpTools);
      process.env.T3CODE_PERSONAL_MCP_DEFER = "off";
      assert.isFalse(flavor.deferMcpTools);
    } finally {
      if (previous === undefined) {
        delete process.env.T3CODE_PERSONAL_MCP_DEFER;
      } else {
        process.env.T3CODE_PERSONAL_MCP_DEFER = previous;
      }
    }
  });

  it("keeps a successful subagent launch running until the parent turn becomes idle", () => {
    const batch = flavor.extractSubagentUpdate?.({
      toolCallId: "trajectory:4",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: { rawOutput: "Started two agents." },
    });
    assert.equal(batch?.status, "running");
    assert.equal(batch?.prompt, "Started two agents.");
    assert.isNull(batch?.result);
    assert.isTrue(flavor.subagentsIdleOnTurnCompletion);

    // Permission prompts carry the launch; later updates for the same call do not.
    const launch = flavor.extractSubagentUpdate?.({
      toolCallId: "35bea692fa95447fbdae6333fec5515f",
      title: "Run invoke_subagent?",
      kind: "other",
      status: "pending",
      data: {
        rawInput: {
          Subagents: [{ TypeName: "research", Role: "Readme Reader", Prompt: "Read README.md" }],
        },
      },
    });
    assert.equal(launch?.title, "Readme Reader");
    assert.equal(launch?.prompt, "Read README.md");

    // agy 1.5.x auto-approves one subagent per call with a flat input.
    const single = flavor.extractSubagentUpdate?.({
      toolCallId: "call_16976942396429577770",
      title: "Run invoke_subagent",
      kind: "other",
      status: "completed",
      data: {
        rawInput: { TypeName: "research", Role: "Codebase Researcher", Prompt: "Read README.md" },
      },
    });
    assert.equal(single?.status, "running");
    assert.equal(single?.title, "Codebase Researcher");
    assert.equal(single?.prompt, "Read README.md");
  });

  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });

  it("keeps the question card to the agent's own options so a typed answer cannot be sent", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_2", [
        { optionId: "opt-main", name: "main", kind: "allow_once" },
        { optionId: "opt-dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.strictEqual(question?.question.allowCustomAnswer, false);
    assert.deepEqual(
      question?.question.options.map((option) => option.value),
      ["opt-main", "opt-dev"],
    );
    assert.deepEqual(question?.respond({ interaction_2: "opt-dev" }), {
      outcome: { outcome: "selected", optionId: "opt-dev" },
    });
  });
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("AntigravityAdapterV2 harness recovery", () => {
  const recoverHarnessFailure = (
    harnessFailure: "1" | "pending" | "after-end-turn",
    firstTurnStatuses: ReadonlyArray<"failed" | "completed">,
  ) => {
    let terminationCount = 0;
    return Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped();
      const requestLogPath = path.join(workspace, "requests.jsonl");
      let processCount = 0;
      const firstRuntimeTerminated = yield* Deferred.make<void>();
      let firstRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-recovery-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          Effect.suspend(() => {
            processCount += 1;
            const processNumber = processCount;
            return makeAntigravityAcpRuntime({
              ...input,
              onTermination: (error) =>
                (input.onTermination?.(error) ?? Effect.void).pipe(
                  Effect.tap(
                    Effect.sync(() => {
                      terminationCount += 1;
                    }),
                  ),
                  Effect.andThen(
                    processNumber === 1
                      ? Deferred.succeed(firstRuntimeTerminated, undefined)
                      : Effect.void,
                  ),
                ),
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_REQUEST_LOG_PATH: requestLogPath,
                  ...(processNumber === 1
                    ? { T3_ACP_ANTIGRAVITY_HARNESS_FAILURE: harnessFailure }
                    : {}),
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.tap((runtime) =>
                Effect.sync(() => {
                  if (processNumber === 1) firstRuntime = runtime;
                }),
              ),
            );
          }),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-recovery");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-recovery"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const terminal = Stream.fromQueue(events).pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      yield* session.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, modelSelection, now }),
      );
      const first = yield* terminal;
      assert.equal(first._tag, "Some");
      if (first._tag === "Some") assert.include(firstTurnStatuses, first.value.status);
      if (harnessFailure === "after-end-turn") {
        assert.exists(firstRuntime);
        yield* firstRuntime!.notify("_test/harness-failure", {});
      }
      // The adapter must retire the first process even when end_turn won the race.
      yield* Deferred.await(firstRuntimeTerminated);
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          modelSelection,
          now,
          ordinal: 2,
        }),
      );
      const completed = yield* terminal;
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some") assert.equal(completed.value.status, "completed");
      assert.equal(processCount, 2);
      assert.equal(terminationCount, 1);
      const requests = (yield* fileSystem.readFileString(requestLogPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: { sessionId?: string } });
      const resumeRequests = requests.filter((request) => request.method === "session/resume");
      assert.equal(resumeRequests.length, 1);
      assert.equal(resumeRequests[0]?.params?.sessionId, "mock-session-1");
    }).pipe(
      Effect.provide(layerSession),
      Effect.scoped,
      Effect.tap(Effect.sync(() => assert.equal(terminationCount, 1))),
    );
  };

  it.live("fails an open turn and resumes its saved session after a harness failure", () =>
    recoverHarnessFailure("pending", ["failed"]),
  );

  it.live("resumes the saved session after a harness failure races end_turn", () =>
    recoverHarnessFailure("1", ["failed", "completed"]),
  );

  it.live("resumes in a fresh process when the native failure arrives after end_turn", () =>
    recoverHarnessFailure("after-end-turn", ["completed"]),
  );
});

describe("AntigravityAdapterV2 compaction", () => {
  it.live.each([
    { nativeGoals: false, compact: false },
    { nativeGoals: true, compact: false },
    { nativeGoals: false, compact: true },
  ])(
    "negotiates native goals ($nativeGoals) and advertised compaction ($compact)",
    ({ nativeGoals, compact }) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-compact-" });
        const requestLog = path.join(logs, "requests.ndjson");
        const instanceId = ProviderInstanceId.make("antigravity-compaction-test");
        const goalSupport = yield* Ref.make(false);
        const startupMilestone = yield* Deferred.make<void>();
        const consumeStartupCommands = yield* Deferred.make<void>();
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AVAILABLE_COMMANDS: compact ? "compact" : "",
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime) => ({
                ...runtime,
                drainEvents: Deferred.succeed(startupMilestone, undefined).pipe(
                  Effect.andThen(runtime.drainEvents),
                ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
          supportsNativeGoals: Ref.get(goalSupport).pipe(
            Effect.tap(() => Deferred.succeed(startupMilestone, undefined)),
          ),
          onSessionEvent: (event) =>
            event._tag === "AvailableCommandsUpdated"
              ? Deferred.await(consumeStartupCommands).pipe(
                  Effect.andThen(Ref.set(goalSupport, nativeGoals)),
                )
              : Effect.void,
        });
        const threadId = ThreadId.make("thread-antigravity-compaction");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const opening = yield* adapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(startupMilestone);
        yield* Deferred.succeed(consumeStartupCommands, undefined);
        const session = yield* Fiber.join(opening);
        const compactThread = session.compactThread;
        assert.isDefined(compactThread);
        assert.equal(session.providerSession.capabilities.turns.supportsNativeGoals, nativeGoals);
        assert.equal((yield* adapter.getCapabilities()).turns.supportsNativeGoals, nativeGoals);
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const turnInput = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Compact the conversation.",
        });
        if (compact) {
          yield* compactThread!(turnInput);
          const events = yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "compaction" &&
                event.turnItem.status === "completed",
            ),
          );
        } else {
          const error = yield* compactThread!(turnInput).pipe(Effect.flip);
          assert.instanceOf(error, ProviderAdapter.ProviderAdapterTurnStartError);
          assert.instanceOf(error.cause, ProviderAdapter.ProviderCompactionUnsupportedError);
        }
        const prompts = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: unknown } })
          .filter((request) => request.method === "session/prompt")
          .map((request) => request.params?.prompt);
        assert.deepEqual(prompts, compact ? [[{ type: "text", text: "/compact" }]] : []);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 session open", () => {
  it.effect.each([
    {
      name: "browser sign-in",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause: undefined,
      }),
      requiresSignIn: true,
    },
    {
      name: "ACP authentication required",
      cause: EffectAcpErrors.AcpRequestError.authRequired(),
      requiresSignIn: true,
    },
    {
      name: "transport failure",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: "Connection closed",
        cause: undefined,
      }),
      requiresSignIn: undefined,
    },
  ] as const)("classifies $name during session open", ({ cause, requiresSignIn }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-sign-in-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: () => Effect.fail(cause),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-sign-in");
      const error = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-sign-in"),
          modelSelection: { instanceId, model: "gemini-test-low" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      assert.equal(
        error._tag === "ProviderAdapterOpenSessionError" && error.requiresSignIn,
        requiresSignIn,
      );
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("serves confined reads and leaves edits to the agent's diff tools", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
      const requestLog = path.join(logs, "requests.ndjson");
      const crypto = yield* SecureRandom.SecureRandom;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_REQUEST_LOG_PATH: requestLog },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(host.paths.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-containment"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      const requests = (yield* fileSystem.readFileString(requestLog))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: {
                clientCapabilities?: { fs?: unknown };
                clientInfo?: { name?: string };
                additionalDirectories?: unknown;
              };
            },
        );
      const initialize = requests.find((request) => request.method === "initialize");
      // agy runs shell commands from its lexicographically first root, so attachments
      // must reach it through client reads, never as an extra workspace root.
      assert.isUndefined(
        requests.find((request) => request.method === "session/new")?.params?.additionalDirectories,
      );
      assert.deepEqual(initialize?.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: false,
      });
      assert.equal(initialize?.params?.clientInfo?.name, "zed");
      assert.isUndefined(writeTextFile);
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file reads");
      }
      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* fileSystem.makeDirectory(path.dirname(insidePath), { recursive: true });
      yield* fileSystem.writeFileString(insidePath, "inside");
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");
      yield* fileSystem.writeFileString(insidePath, "\uFEFFfirst\né中🙂\nlast");
      const sliced = yield* readTextFile(
        { sessionId: "mock-session-1", path: insidePath, line: 2, limit: 1 },
        context("fs/read_text_file"),
      );
      assert.equal(sliced.content, "é中🙂");
      yield* fileSystem.writeFileString(insidePath, "inside");
      for (const [name, bytes] of [
        ["image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["data.bin", new Uint8Array([0x61, 0, 0x62])],
      ] as const) {
        const binaryPath = path.join(workspace, name);
        yield* fileSystem.writeFile(binaryPath, bytes);
        const binaryRead = yield* readTextFile(
          { sessionId: "mock-session-1", path: binaryPath },
          context("fs/read_text_file"),
        ).pipe(Effect.flip);
        assert.propertyVal(binaryRead, "code", -32602, `${name} is refused as binary`);
      }

      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead));
      const linkPath = path.join(workspace, "linked-secret.txt");
      yield* fileSystem.symlink(outsideFile, linkPath);
      const linkedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: linkPath },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedRead), "a read through an escaping symlink is denied");
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
      const host = yield* ProviderHost.ProviderHost;
      const document = ChatFileAttachment.make({
        type: "file",
        id: "native-pdf",
        name: "diagram.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      });
      const documentPath = host.resolveAttachmentPath(document)!;
      yield* fileSystem.writeFileString(documentPath, "%PDF-1.7");
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              prompt: (request) =>
                Deferred.succeed(promptReceived, request).pipe(
                  Effect.andThen(runtime.prompt(request)),
                ),
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    initializeResult: {
                      ...started.initializeResult,
                      agentCapabilities: {
                        ...started.initializeResult.agentCapabilities,
                        promptCapabilities: { image: true, audio: true, embeddedContext: true },
                      },
                    },
                  })),
                ),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspaceA = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-a-" });
      const workspaceB = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-b-" });
      yield* fileSystem.writeFileString(path.join(workspaceA, "a.txt"), "from a");
      yield* fileSystem.writeFileString(path.join(workspaceB, "b.txt"), "from b");
      const policyFor = (cwd: string) =>
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
      const threadId = ThreadId.make("thread-antigravity-workspace-change");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-change"),
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-workspace-change"),
            title: "Antigravity workspace change",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceB,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-antigravity-workspace-change"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-workspace-change"),
          rootNodeId: NodeId.make("node-antigravity-workspace-change"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-antigravity-workspace-change"),
            text: "read b.txt",
            attachments: [document],
          },
          modelSelection,
          runtimePolicy: policyFor(workspaceB),
        })
        .pipe(Effect.forkScoped);
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      const sent = yield* Deferred.await(promptReceived);
      assert.deepEqual(
        sent.prompt.filter((block) => block.type === "resource_link"),
        [
          {
            type: "resource_link",
            uri: (yield* path.toFileUrl(documentPath)).href,
            name: "diagram.pdf",
            mimeType: "application/pdf",
            size: 8,
          },
        ],
      );
      assert.include(JSON.stringify(sent.prompt), JSON.stringify(documentPath).slice(1, -1));
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = { requestId: "test-read", method: "fs/read_text_file" };
      const fromB = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceB, "b.txt") },
        context,
      );
      assert.equal(fromB.content, "from b");
      const fromA = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceA, "a.txt") },
        context,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fromA), "the previous workspace is no longer readable");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect("shows the page html_render published when the agent reports only a summary", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-html-render-test");
      const threadId = ThreadId.make("thread-antigravity-html-render");
      const page = (name: string) => ({
        attachmentId: `${threadId}-${name}-html`,
        title: "Revenue",
        height: 240,
      });
      // Long enough that Antigravity bounds the html the adapter sees.
      const rows = Array.from({ length: 500 }, (_, row) => `<tr><td>Row ${row}</td></tr>`);
      const report = { html: `<table>${rows.join("")}</table>`, title: "Revenue", height: 240 };
      const failed = { ...report, html: "<p>Revenue</p>" };
      const errored = { ...report, html: "<p>Revenue error</p>" };
      const telemetry = {
        html: `<ul>${rows.join("").replaceAll("tr", "li")}</ul>`,
        title: "Telemetry",
        height: 411,
      };
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy_acp_server 1.3/1.4 without a permission prompt: the call is
              // titled "Running <tool>" and completes with the step's summary
              // in place of the MCP result.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    ["published", report],
                    ["unpublished", { ...report, html: "<p>Costs</p>" }],
                    ["failed", failed],
                    ["error", errored],
                  ] as const;
                  for (const [toolCallId, rawInput] of calls) {
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("report"));
                  yield* mcpSessions.recordHtmlRender(threadId, failed, page("failed"));
                  yield* mcpSessions.recordHtmlRender(threadId, errored, page("error"));
                  for (const [toolCallId, status] of [
                    ["unpublished", "completed"],
                    ["failed", "failed"],
                    ["published", "completed"],
                    ["published", "completed"],
                  ] as const) {
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status,
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "error",
                    status: "completed",
                    rawOutput: { result: { isError: true, content: [] } },
                  });
                  for (const [name, rawInput] of [
                    ["failed", failed],
                    ["error", errored],
                  ] as const) {
                    const toolCallId = `${name}-retry`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                    yield* mcpSessions.recordHtmlRender(threadId, rawInput, page(toolCallId));
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: name,
                      status: name === "failed" ? "failed" : "completed",
                      rawOutput:
                        name === "failed"
                          ? "Summary of failed"
                          : { result: { isError: true, content: [] } },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("replacement"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: { htmlRender: page("replacement") },
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: "Summary of published",
                  });
                  // agy 1.5.8 titles the call with its MCP name and completes without any output.
                  yield* send({
                    sessionUpdate: "tool_call",
                    toolCallId: "agy-1.5.8",
                    title: "Run mcp_t3-code_html_render",
                    kind: "other",
                    status: "in_progress",
                    rawInput: { ...telemetry, toolSummary: "Render telemetry" },
                  });
                  yield* mcpSessions.recordHtmlRender(threadId, telemetry, page("agy-1.5.8"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "agy-1.5.8",
                    status: "completed",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-html-render"),
          title: "Antigravity html_render",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-html-render"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-html-render"),
        rootNodeId: NodeId.make("node-antigravity-html-render"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-html-render"),
          text: "chart the revenue",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const tool = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        if (event?.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool") {
          return undefined;
        }
        const item = event.turnItem;
        return {
          status: item.status,
          toolName: item.toolName,
          page: htmlRenderFromToolItem(item),
          output: item.output,
        };
      };

      assert.deepEqual(tool("published"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("replacement"),
        output: { htmlRender: page("replacement") },
      });
      assert.deepEqual(tool("unpublished"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of unpublished",
      });
      assert.deepEqual(tool("failed"), {
        status: "failed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of failed",
      });
      assert.deepEqual(tool("error"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: [],
      });
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "published" &&
          event.turnItem.status === "completed"
            ? [htmlRenderFromToolItem(event.turnItem)]
            : [],
        ),
        [page("report"), page("report"), page("replacement"), page("replacement")],
      );
      for (const name of ["failed-retry", "error-retry", "agy-1.5.8"]) {
        assert.deepEqual(tool(name), {
          status: "completed",
          toolName: "t3-code.html_render",
          page: page(name),
          output: { htmlRender: page(name) },
        });
      }
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, report), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, failed), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, errored), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, telemetry), undefined);
    }).pipe(Effect.provide(layerSession)),
  );
});

/**
 * A session whose prompt reports one running command and returns end_turn, as agy 1.5.11 does
 * for `run_command` once `WaitMsBeforeAsync` passes. The test sends every later frame.
 */
const openSessionWithRunningCommand = Effect.fn("openSessionWithRunningCommand")(function* (
  commandInput: Record<string, unknown>,
  /** The prompt launches one agy 1.5 subagent instead; its records live below this profile. */
  detachedChildProfile?: string,
  /** agy 1.5.11 answers a steered prompt once the next one arrives, which runs to `releaseSteer`. */
  steering?: { readonly agentVersion: string; readonly holdsFirstPrompt: boolean },
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
  let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
  const send = (update: EffectAcpSchema.SessionUpdate) =>
    sessionUpdate === undefined
      ? Effect.die("the adapter must handle session updates")
      : sessionUpdate(normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }));
  const command = {
    toolCallId: "call_fetch",
    kind: "execute",
    title: "node fetch_throughput.mjs",
    rawInput: { CommandLine: "node fetch_throughput.mjs", ...commandInput },
  } as const;
  let cancels = 0;
  const prompts: Array<{
    readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
    readonly released: Deferred.Deferred<void> | undefined;
  }> = [];
  const steered = yield* Deferred.make<void>();
  const releaseSteer = yield* Deferred.make<void>();
  let terminate: AntigravityAdapterV2RuntimeInput["onTermination"];
  const usage = { sessionUpdate: "usage_update", used: 9000, size: 1048576 } as const;
  const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
  const instanceId = ProviderInstanceId.make("antigravity-wake-test");
  const threadId = ThreadId.make("thread-antigravity-wake");
  const adapter = yield* makeAntigravityAdapterV2({
    instanceId,
    selfInvocation: yield* resolveSelfInvocation(),
    continuationRequests: { offer: (request) => Effect.sync(() => void offers.push(request)) },
    makeRuntime: (input) => {
      terminate = input.onTermination;
      return makeAntigravityAcpRuntime({
        ...input,
        childProcessSpawner,
        spawn: {
          command: process.execPath,
          args: [mockAgentPath],
          cwd: input.cwd,
          env: {
            T3_ACP_ANTIGRAVITY: "1",
            ...(steering === undefined ? {} : { T3_ACP_AGENT_VERSION: steering.agentVersion }),
          },
        },
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, crypto),
        Effect.map((runtime): RuntimeService => ({
          ...runtime,
          cancel: Effect.sync(() => {
            cancels += 1;
          }),
          handleSessionUpdate: (handler) =>
            Effect.sync(() => {
              sessionUpdate = handler;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          prompt: (payload, promptOptions) =>
            Effect.gen(function* () {
              prompts.push({ prompt: payload.prompt, released: promptOptions?.released });
              if (promptOptions?.dispatched !== undefined) {
                yield* Deferred.succeed(promptOptions.dispatched, undefined);
              }
              if (prompts.length > 1) {
                yield* Deferred.succeed(steered, undefined);
                yield* Deferred.await(releaseSteer);
                return { stopReason: "end_turn" as const };
              }
              yield* send(
                detachedChildProfile === undefined
                  ? { sessionUpdate: "tool_call", ...command, status: "in_progress" }
                  : {
                      sessionUpdate: "tool_call",
                      toolCallId: "call_research",
                      kind: "other",
                      title: "Run invoke_subagent",
                      status: "completed",
                      rawInput: { TypeName: "research", Role: "Researcher", Prompt: "Read it" },
                    },
              );
              yield* send({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "I'll render once the fetch finishes." },
              });
              yield* send(usage);
              if (steering?.holdsFirstPrompt === true) yield* Deferred.await(steered);
              return { stopReason: "end_turn" as const };
            }),
        })),
      );
    },
    withProcess: (_stop, task) => task,
    defaultModel: Effect.undefined,
    ...(detachedChildProfile === undefined ? {} : { profileDirectory: detachedChildProfile }),
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "gemini-test-low" } as const;
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-antigravity-wake"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const until = (done: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (done(event)) return seen;
      }
    });
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const startTurn = (ordinal: number, continuation: boolean) =>
    session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-antigravity-wake"),
        title: "Antigravity wake",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-antigravity-wake-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-antigravity-wake-${ordinal}`),
      rootNodeId: NodeId.make(`node-antigravity-wake-${ordinal}`),
      providerThread,
      message: {
        ...(continuation
          ? { createdBy: "agent" as const, creationSource: "provider" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
        messageId: MessageId.make(`message-antigravity-wake-${ordinal}`),
        text: "chart the throughput",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });

  return {
    session,
    providerThread,
    command,
    usage,
    offers,
    send,
    startTurn,
    until,
    throughTerminal: until((event) => event.type === "turn.terminal"),
    // The reply before end_turn closes when the prompt settles, held open or not.
    throughPromptSettled: until(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "assistant_message" &&
        event.turnItem.status === "completed",
    ),
    requestPermission: (...args: Parameters<NonNullable<typeof requestPermission>>) =>
      requestPermission === undefined
        ? Effect.die("the adapter must handle permission requests")
        : requestPermission(...args),
    cancels: () => cancels,
    prompts,
    releaseSteer: Deferred.succeed(releaseSteer, undefined),
    runtimeDies: Effect.suspend(
      () =>
        terminate?.(
          new EffectAcpErrors.AcpTransportError({ detail: "agent exited", cause: "exit" }),
        ) ?? Effect.die("the adapter must watch its runtime"),
    ),
  };
});

describe("AntigravityAdapterV2 work after the prompt ends", () => {
  // agy sets `IsDaemon` on a command it does not wait for. When it exits, the agent replies
  // with no prompt open.
  it.effect("continues in one run when a finished daemon wakes the agent", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, throughTerminal, requestPermission } =
        yield* openSessionWithRunningCommand({ IsDaemon: true, WaitMsBeforeAsync: 500 });
      yield* startTurn(1, false);
      const promptTerminal = (yield* throughTerminal).at(-1);
      assert.equal(promptTerminal?.type === "turn.terminal" && promptTerminal.status, "completed");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      // The agent can ask before the app has started the continuation run.
      const followUp = { toolCallId: "call_analyze", kind: "execute", title: "node analyze.mjs" };
      const permission = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { ...followUp, status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { requestId: "permission-1", method: "session/request_permission" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      assert.deepEqual(yield* Fiber.join(permission), {
        outcome: { outcome: "selected", optionId: "allow" },
      });

      // The model took 6.7 s to answer the finished command; the run must outlast that silence.
      yield* TestClock.adjust("10 seconds");
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "completed" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const continued = yield* throughTerminal;
      const continuedTerminal = continued.at(-1);
      assert.equal(
        continuedTerminal?.type === "turn.terminal" && continuedTerminal.status,
        "completed",
      );
      assert.isTrue(
        continued.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.runId === RunId.make("run-antigravity-wake-2"),
        ),
        "the reply belongs to the continuation run",
      );
      const finished = continued.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      assert.lengthOf(offers, 1, "one wake is one run");
    }).pipe(Effect.provide(layerSession)),
  );

  // Frames as agy 1.5.11 sent them for `run_command` with `WaitMsBeforeAsync`: the prompt returns
  // end_turn while the command runs, and the agent replies when the command finishes.
  it.effect("keeps the run open while a command the agent waits for still runs", () =>
    Effect.gen(function* () {
      const { command, usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      yield* TestClock.adjust("10 minutes");
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* TestClock.adjust("10 seconds");
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the chart." },
      });
      yield* send(usage);
      yield* TestClock.adjust("3 seconds");
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Here is the chart.", "the reply is part of the run");
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  // agy names its background commands `<session>/task-<n>`; the agent passes that to
  // t3_background_wait, which must not fail since the adapter already holds the run open.
  it.effect("accepts t3_background_wait for a command it already tracks", () =>
    Effect.gen(function* () {
      const { session, providerThread, startTurn, throughPromptSettled } =
        yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
      yield* startTurn(1, false);
      yield* throughPromptSettled;
      const taskIds = ["mock-session-1/task-2"];
      assert.isDefined(session.awaitBackgroundTasks, "t3_background_wait must not be unsupported");
      const result = yield* session.awaitBackgroundTasks!({
        providerThread,
        taskIds,
        awaited: true,
      });
      assert.deepEqual(result.matched, taskIds);
    }).pipe(Effect.provide(layerSession)),
  );

  // agy 1.5.11 reads a prompt sent mid-turn as a steer: it answers the running prompt end_turn
  // and goes on under the new one. session/cancel would end its running commands and subagents.
  it.effect("steers a running prompt with the next one and leaves its work running", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand({}, undefined, {
        agentVersion: "1.5.11",
        holdsFirstPrompt: true,
      });
      const { session, providerThread, command, usage, send, startTurn, until } = opened;
      assert.isTrue(session.providerSession.capabilities.turns.supportsActiveSteering);
      yield* startTurn(1, false);
      const started = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_artist",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { Role: "Artist", Prompt: "Paint the scooter" },
      });

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Use opus subagents from now on",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1]!.prompt, [
        { type: "text", text: "Use opus subagents from now on" },
      ]);
      assert.isTrue(
        yield* Deferred.isDone(opened.prompts[0]!.released!),
        "the steered prompt frees the runtime for the steer",
      );
      // The steered prompt has answered end_turn; the turn must outlast the finalize debounce.
      yield* TestClock.adjust("10 seconds");

      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Switching to opus subagents." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      const run = [...started, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "Switching to opus subagents.");
      const finished = run.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === command.toolCallId,
      );
      assert.equal(finished?.type === "turn_item.updated" && finished.turnItem.status, "completed");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );

  // A wake run has no prompt of its own, yet agy can keep working in it for minutes.
  it.effect("steers a continuation run that keeps working after its wake", () =>
    Effect.gen(function* () {
      const opened = yield* openSessionWithRunningCommand(
        { IsDaemon: true, WaitMsBeforeAsync: 500 },
        undefined,
        { agentVersion: "1.5.11", holdsFirstPrompt: false },
      );
      const { session, providerThread, command, offers, send, startTurn, until, throughTerminal } =
        opened;
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call_update",
        ...command,
        status: "completed",
        rawOutput: { output: "Command exited with code 0.", exit_code: 0 },
      });
      assert.lengthOf(offers, 1, "the finished daemon must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      const followUp = { toolCallId: "call_build", kind: "execute", title: "vp run build" };
      yield* send({ sessionUpdate: "tool_call", ...followUp, status: "in_progress" });
      const continued = yield* until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === followUp.toolCallId,
      );
      const providerTurnId = continued.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;

      const steer = yield* session
        .steerTurn({
          threadId: ThreadId.make("thread-antigravity-wake"),
          runId: RunId.make("run-antigravity-wake-2"),
          providerThread,
          providerTurnId,
          message: {
            messageId: MessageId.make("message-antigravity-steer"),
            text: "Skip the build",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(
        Exit.isSuccess(steer),
        `a working wake run must accept a steer: ${String(Exit.isFailure(steer) && steer.cause)}`,
      );
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's work");
      assert.lengthOf(opened.prompts, 2);
      assert.deepEqual(opened.prompts[1]!.prompt, [{ type: "text", text: "Skip the build" }]);

      yield* send({ sessionUpdate: "tool_call_update", ...followUp, status: "completed" });
      yield* TestClock.adjust("16 minutes");
      const silent = yield* until((event) => event.type === "turn.terminal");
      const terminal = silent.at(-1);
      assert.equal(
        terminal?.type === "turn.terminal" && terminal.status,
        "failed",
        "a silent steer prompt must still hit the inactivity timeout",
      );
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("steers a run held open by a detached subagent without stopping it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const opened = yield* openSessionWithRunningCommand({}, profile, {
        agentVersion: "1.5.11",
        holdsFirstPrompt: false,
      });
      const { session, providerThread, usage, send, startTurn, until, throughPromptSettled } =
        opened;
      yield* startTurn(1, false);
      const prompt = yield* throughPromptSettled;
      const providerTurnId = prompt.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;
      yield* TestClock.adjust("10 minutes");

      yield* session.steerTurn({
        threadId: ThreadId.make("thread-antigravity-wake"),
        runId: RunId.make("run-antigravity-wake-1"),
        providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("message-antigravity-steer"),
          text: "Also check the footnotes",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      assert.equal(opened.cancels(), 0, "a steer must not cancel the agent's subagents");
      assert.lengthOf(opened.prompts, 2);
      yield* write(records("mock-session-1", "messages"), "report.json", { sender: "child-1" });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I'll have the footnotes checked too." },
      });
      yield* send(usage);
      yield* opened.releaseSteer;
      const run = [...prompt, ...(yield* until((event) => event.type === "turn.terminal"))];
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.include(JSON.stringify(run), "I'll have the footnotes checked too.");
      const subagentStatuses = run.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      );
      assert.notInclude(subagentStatuses, "interrupted");
      assert.equal(subagentStatuses.at(-1), "idle");
    }).pipe(Effect.provide(layerSession)),
  );

  // Files as agy 1.5.12 wrote them: the launch sits in the child's inbox, and the child's report
  // lands in the parent's inbox with no session update. Only the agent's own reply follows.
  it.effect.each([
    { reports: "after the prompt ends", duringPrompt: false },
    { reports: "while the prompt runs", duringPrompt: true },
  ])("keeps a detached subagent running until it reports $reports", ({ duringPrompt }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const records = (conversationId: string, kind: string) =>
        path.join(profile, "antigravity-acp", "brain", conversationId, ".system_generated", kind);
      const write = (directory: string, name: string, value: unknown) =>
        fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(directory, name), JSON.stringify(value)),
            ),
          );
      yield* write(records("mock-session-1", "subagents"), "child-1.json", {});
      yield* write(records("child-1", "messages"), "launch.json", {
        sender: "mock-session-1",
        sourceMetadata: { tool: { toolCall: { id: "call_research", name: "invoke_subagent" } } },
      });
      const report = write(records("mock-session-1", "messages"), "report.json", {
        sender: "child-1",
      });
      if (duringPrompt) yield* report;

      const { usage, offers, send, startTurn, until, throughPromptSettled } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      const statuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent.status] : [],
        );
      const prompt = yield* throughPromptSettled;
      assert.equal(statuses(prompt).at(-1), duringPrompt ? "idle" : "running");
      if (!duringPrompt) {
        yield* TestClock.adjust("10 minutes");
        yield* report;
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The researcher found it." },
        });
        yield* send(usage);
        yield* TestClock.adjust("3 seconds");
      }
      const run = yield* until((event) => event.type === "turn.terminal");
      const terminal = run.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
      assert.equal(statuses([...prompt, ...run]).at(-1), "idle");
      assert.equal(
        JSON.stringify(run).includes("The researcher found it."),
        !duringPrompt,
        "the reply about the report is part of the run",
      );
      assert.lengthOf(offers, 0, "the open run needs no continuation");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("ends a continuation run whose replayed reply launched a subagent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // No records: nothing proves a child is at work, so none may hold a run open.
      const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-kids-" });
      const { usage, offers, send, startTurn, throughTerminal } =
        yield* openSessionWithRunningCommand({}, profile);
      yield* startTurn(1, false);
      yield* throughTerminal;
      yield* send({
        sessionUpdate: "tool_call",
        toolCallId: "call_follow_up",
        kind: "other",
        title: "Run invoke_subagent",
        status: "completed",
        rawInput: { TypeName: "research", Role: "Checker", Prompt: "Check it" },
      });
      yield* send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Started a checker." },
      });
      yield* send(usage);
      assert.lengthOf(offers, 1, "the agent's own reply must wake the thread");
      yield* offers[0]!.dispatchIfCurrent!(Effect.void);
      yield* startTurn(2, true);
      yield* TestClock.adjust("3 seconds");
      const terminal = (yield* throughTerminal).at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect.each([
    // session/cancel ends the agent's commands, so only Stop may send it.
    { ending: "Stop", cancels: 1, status: "interrupted" },
    { ending: "a new message", cancels: 0, status: "interrupted" },
    { ending: "the agent exiting", cancels: 0, status: "failed" },
  ] as const)(
    "ends a run held open by a running command on $ending",
    ({ ending, cancels, status }) =>
      Effect.gen(function* () {
        const opened = yield* openSessionWithRunningCommand({ WaitMsBeforeAsync: 10000 });
        yield* opened.startTurn(1, false);
        const started = yield* opened.throughPromptSettled;
        const turn = started.find((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") return assert.fail("the turn must start");
        if (ending === "the agent exiting") {
          yield* opened.runtimeDies;
        } else {
          yield* opened.session.interruptTurn({
            providerThread: opened.providerThread,
            providerTurnId: turn.providerTurn.id,
            ...(ending === "Stop" ? { requestRuntimeRestart: true } : {}),
          });
        }
        const terminal = (yield* opened.throughTerminal).at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, status);
        assert.equal(opened.cancels(), cancels);
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 subagent reads", () => {
  it.effect("completes a read T3 served when the agent later fails it with a step error", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-reads-outside-",
      });
      const served = path.join(workspace, "served.ts");
      yield* fileSystem.writeFileString(served, "export {};");
      const denied = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(denied, "secret");
      const unseen = path.join(workspace, "unseen.ts");
      const retried = path.join(workspace, "retried.ts");
      const stepError = 'Model produced invalid output. ("model output error")';
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-subagent-reads-test");
      const threadId = ThreadId.make("thread-antigravity-subagent-reads");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              // agy_acp_server announces a subagent's client_view_file on the parent session,
              // never completes it, then fails every open call with the next step error.
              prompt: () =>
                Effect.gen(function* () {
                  if (sessionUpdate === undefined || readTextFile === undefined) {
                    return yield* Effect.die("the adapter must handle updates and reads");
                  }
                  const send = sessionUpdate;
                  const handleRead = readTextFile;
                  const update = (update: EffectAcpSchema.SessionUpdate) =>
                    send(
                      normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }),
                    );
                  // The agent's own view_file never reaches T3, so it must not take a served read.
                  const reads = [
                    ["call_native", served, "Running view_file"],
                    ["call_served", served, "Running client_view_file"],
                    ["call_missing", retried, "Running client_view_file"],
                    ["call_retried", retried, "Running client_view_file"],
                    ["call_denied", denied, "Running client_view_file"],
                    ["call_unseen", unseen, "Running client_view_file"],
                  ] as const;
                  for (const [toolCallId, target, title] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title,
                      kind: "read",
                      status: "in_progress",
                      rawInput: { absolute_path: target },
                      locations: [{ path: target }],
                    });
                  }
                  const serve = (target: string) =>
                    handleRead(
                      { sessionId: "subagent-conversation", path: target },
                      { requestId: `read-${target}`, method: "fs/read_text_file" },
                    ).pipe(Effect.exit);
                  yield* serve(served);
                  yield* serve(retried);
                  yield* fileSystem.writeFileString(retried, "export {};").pipe(Effect.orDie);
                  yield* serve(retried);
                  yield* serve(denied);
                  for (const [toolCallId] of reads) {
                    yield* update({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "failed",
                      rawOutput: stepError,
                    });
                  }
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-subagent-reads"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-subagent-reads"),
          title: "Antigravity subagent reads",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-subagent-reads"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-subagent-reads"),
        rootNodeId: NodeId.make("node-antigravity-subagent-reads"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-subagent-reads"),
          text: "review the codebase",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const read = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? { status: event.turnItem.status, output: event.turnItem.output }
          : undefined;
      };

      const firstEvent = (nativeId: string, status: string) =>
        events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId &&
            event.turnItem.status === status,
        );
      // T3 completes a served read itself instead of leaving it running until the flush.
      assert.isAbove(firstEvent("call_served", "completed"), -1);
      assert.isBelow(firstEvent("call_served", "completed"), firstEvent("call_native", "failed"));
      const failed = { status: "failed" as const, output: stepError };
      assert.deepEqual(read("call_served"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_retried"), { status: "completed", output: undefined });
      assert.deepEqual(read("call_native"), failed);
      assert.deepEqual(read("call_missing"), failed);
      assert.deepEqual(read("call_denied"), failed);
      assert.deepEqual(read("call_unseen"), failed);
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 runtime mode ceiling", () => {
  const modesSetFor = (
    pickedMode: string,
    modes: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode" | "maxRuntimeMode">,
  ) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const modesSet: Array<string> = [];
      const instanceId = ProviderInstanceId.make("antigravity-ceiling-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              setMode: (modeId) =>
                Effect.sync(() => {
                  modesSet.push(modeId);
                }).pipe(Effect.andThen(runtime.setMode(modeId))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-ceiling");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-ceiling"),
        modelSelection: {
          instanceId,
          model: "gemini-test-low",
          options: [{ id: "_t3/session-mode", value: pickedMode }],
        },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...modes,
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });
      return modesSet;
    }).pipe(Effect.provide(layerSession), Effect.scoped);

  it.effect("does not apply a picked session mode above the thread's runtime mode", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* modesSetFor("yolo", { runtimeMode: "approval-required" }), [
        "default",
      ]);
      assert.deepEqual(
        yield* modesSetFor("auto_edit", {
          runtimeMode: "approval-required",
          maxRuntimeMode: "auto-accept-edits",
        }),
        ["default"],
      );
      // A narrower mode is still the user's to pick.
      assert.deepEqual(yield* modesSetFor("default", { runtimeMode: "auto-accept-edits" }), [
        "auto_edit",
        "default",
      ]);
    }),
  );

  it.effect("leaving Plan keeps the permission mode the thread has now", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      let runtime: AcpSessionRuntime.AcpSessionRuntime["Service"] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-plan-exit-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.tap((made) =>
              Effect.sync(() => {
                runtime = made;
              }),
            ),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-plan-exit");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const planPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "plan",
        cwd: process.cwd(),
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-plan-exit"),
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: planPolicy,
      });
      const supervisedPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy: supervisedPolicy,
          modelSelection,
          now: yield* DateTime.now,
        }),
      );
      yield* Stream.fromQueue(events).pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal((yield* runtime!.getModeState)?.currentModeId, "default");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 session system prompt", () => {
  it.effect.each(["1.4.5", "1.4.1"])(
    "carries PR linking once in the %s session setup or once per turn",
    (agentVersion) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
        const requestLog = path.join(logs, "requests.ndjson");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
        const instanceId = ProviderInstanceId.make("antigravity-system-prompt-test");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_AGENT_VERSION: agentVersion,
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                  T3_ACP_HANG_PROMPT_FOREVER: "1",
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                prompt: (request) =>
                  Deferred.succeed(promptReceived, request).pipe(
                    Effect.andThen(runtime.prompt(request)),
                  ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-sp-" });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const threadId = ThreadId.make("thread-antigravity-system-prompt");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-system-prompt"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session
          .startTurn({
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project-antigravity-system-prompt"),
              title: "Antigravity system prompt",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId: RunId.make("run-antigravity-system-prompt"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt-antigravity-system-prompt"),
            rootNodeId: NodeId.make("node-antigravity-system-prompt"),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-antigravity-system-prompt"),
              text: "open a PR",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        const sent = JSON.stringify((yield* Deferred.await(promptReceived)).prompt);
        const sessionNew = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { _meta?: unknown } })
          .find((request) => request.method === "session/new");
        const append = JSON.stringify(sessionNew?.params?._meta ?? null);
        // Identity stays per turn either way.
        assert.include(sent, "through the Antigravity harness, as gemini-test-low");
        if (agentVersion === "1.4.5") {
          assert.include(append, "pull_request_linking");
          assert.notInclude(sent, "<pull_request_linking>");
        } else {
          assert.notInclude(append, "systemPrompt");
          assert.include(sent, "<pull_request_linking>");
        }
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 Eco mode", () => {
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  type PermissionHandler = Parameters<RuntimeService["handleRequestPermission"]>[0];
  type SessionUpdateHandler = Parameters<RuntimeService["handleSessionUpdate"]>[0];

  const ecoPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });

  const makeEcoTurnInput = (input: {
    readonly threadId: ThreadId;
    readonly providerThread: Parameters<typeof makeTurnInput>[0]["providerThread"];
    readonly instanceId: ProviderInstanceId;
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly modelSelection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"];
    readonly now: DateTime.Utc;
    readonly messageId: MessageId;
    readonly text: string;
    readonly runId?: RunId;
    readonly runOrdinal?: number;
    readonly providerTurnOrdinal?: number;
  }): ProviderAdapter.ProviderAdapterV2TurnInput => {
    const base = makeTurnInput({
      threadId: input.threadId,
      providerThread: input.providerThread,
      instanceId: input.instanceId,
      runtimePolicy: input.runtimePolicy,
      modelSelection: input.modelSelection,
      now: input.now,
      messageText: input.text,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.runOrdinal === undefined ? {} : { runOrdinal: input.runOrdinal }),
      ...(input.providerTurnOrdinal === undefined
        ? {}
        : { providerTurnOrdinal: input.providerTurnOrdinal }),
    });
    return {
      ...base,
      message: { ...base.message, messageId: input.messageId },
    };
  };

  const makeEcoHarness = (opts: {
    readonly onPrompt: (input: {
      readonly promptIndex: number;
      readonly text: string;
      readonly currentModel: string;
      readonly threadId: ThreadId;
      readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
      readonly requestPermission: (
        req: EffectAcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
      readonly emitUpdate: (
        notification: EffectAcpSchema.SessionNotification,
      ) => Effect.Effect<void>;
    }) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
    readonly onSetConfigOption?: (
      id: string,
      value: unknown,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly onCancel?: () => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity");
      const threadId = ThreadId.make("thread-antigravity-eco");
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("env-eco"),
        threadId,
        providerSessionId: "provider-session-antigravity-eco",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:4321/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: false,
      });

      const runtimeHttpHeaders: Array<
        ReadonlyArray<{ readonly name: string; readonly value: string }>
      > = [];
      const runtimeStdioEnv: Array<
        ReadonlyArray<{ readonly name: string; readonly value: string }>
      > = [];
      const runtimeProcessEnv: Array<NodeJS.ProcessEnv | undefined> = [];
      const configChanges: Array<{ readonly id: string; readonly value: unknown }> = [];
      const promptsSeen: Array<{ readonly text: string; readonly model: string }> = [];
      let currentModel = "gemini-4-neon";
      let currentEffort = "high";
      let promptIndex = 0;

      const makeFakeRuntime = (
        input: AntigravityAdapterV2RuntimeInput,
      ): Effect.Effect<RuntimeService, EffectAcpErrors.AcpError> =>
        Effect.sync(() => {
          const t3Http = input.httpMcpServers?.find(
            (server): server is Extract<EffectAcpSchema.McpServer, { readonly type: "http" }> =>
              "type" in server && server.type === "http" && server.name === "t3-code",
          );
          runtimeHttpHeaders.push(t3Http?.headers ?? []);
          const t3Stdio = input.mcpServers?.find(
            (server): server is Extract<EffectAcpSchema.McpServer, { readonly command: string }> =>
              "command" in server && server.name === "t3-code",
          );
          runtimeStdioEnv.push(t3Stdio?.env ?? []);
          runtimeProcessEnv.push(input.processEnvironment);

          let permissionHandler: PermissionHandler | undefined;
          let sessionUpdateHandler: SessionUpdateHandler | undefined;
          let activeSessionId = "acp-eco-session-1";

          const currentConfigOptions = (): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: currentModel,
              options: [
                { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
              ],
            },
            {
              id: "thought_level",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: currentEffort,
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ];

          const startResult = (
            sessionId: string,
          ): AcpSessionRuntime.AcpSessionRuntimeStartResult => ({
            sessionId,
            modelConfigId: "model",
            initializeResult: {
              protocolVersion: 1,
              agentInfo: { name: "antigravity", version: "1.5.18" },
              agentCapabilities: { loadSession: true },
            },
            sessionSetupResult: {
              configOptions: [...currentConfigOptions()],
              modes: {
                currentModeId: "default",
                availableModes: [{ id: "default", name: "Default" }],
              },
            },
          });

          const runtime = {
            initialize: () => Effect.succeed(startResult(activeSessionId).initializeResult),
            start: () => Effect.succeed(startResult(activeSessionId)),
            getEvents: () => Stream.empty,
            drainEvents: Effect.void,
            configOptionChanges: Stream.empty,
            createSession: () => Effect.succeed(startResult(activeSessionId)),
            activateSession: (sessionId: string) =>
              Effect.sync(() => {
                activeSessionId = sessionId;
                return startResult(sessionId);
              }),
            loadSession: (sessionId: string) =>
              Effect.sync(() => {
                activeSessionId = sessionId;
                return startResult(sessionId);
              }),
            resumeSession: (sessionId: string) =>
              Effect.sync(() => {
                activeSessionId = sessionId;
                return startResult(sessionId);
              }),
            forkSession: () => Effect.succeed(startResult("acp-eco-session-fork")),
            closeSession: () => Effect.void,
            prompt: (
              payload: Parameters<RuntimeService["prompt"]>[0],
              promptOptions?: Parameters<RuntimeService["prompt"]>[1],
            ) =>
              Effect.gen(function* () {
                const idx = ++promptIndex;
                const text = payload.prompt
                  .map((block) => (block.type === "text" ? block.text : ""))
                  .join("\n");
                promptsSeen.push({ text, model: currentModel });
                if (promptOptions?.dispatched !== undefined) {
                  yield* Deferred.succeed(promptOptions.dispatched, undefined).pipe(Effect.ignore);
                }
                return yield* opts.onPrompt({
                  promptIndex: idx,
                  text,
                  currentModel,
                  threadId,
                  mcpSessions,
                  requestPermission: (req) =>
                    permissionHandler === undefined
                      ? Effect.succeed({ outcome: { outcome: "cancelled" } } as const)
                      : permissionHandler(req, {
                          method: "session/request_permission",
                          requestId: `perm-${idx}-${Math.random()}`,
                        }),
                  emitUpdate: (notification) =>
                    sessionUpdateHandler === undefined
                      ? Effect.void
                      : sessionUpdateHandler(notification).pipe(Effect.ignore),
                });
              }),
            cancel: Effect.suspend(() => opts.onCancel?.() ?? Effect.void),
            setMode: () => Effect.void,
            setModel: (modelId: string) =>
              Effect.gen(function* () {
                configChanges.push({ id: "model", value: modelId });
                if (opts.onSetConfigOption !== undefined) {
                  yield* opts.onSetConfigOption("model", modelId);
                }
                currentModel = modelId;
              }),
            setSessionModel: (modelId: string) =>
              Effect.sync(() => {
                currentModel = modelId;
              }),
            setConfigOption: (configId: string, value: unknown) =>
              Effect.gen(function* () {
                configChanges.push({ id: configId, value });
                if (opts.onSetConfigOption !== undefined) {
                  yield* opts.onSetConfigOption(configId, value);
                }
                if (configId === "model" && typeof value === "string") currentModel = value;
                if (configId === "thought_level" && typeof value === "string")
                  currentEffort = value;
                return [...currentConfigOptions()];
              }),
            getConfigOptions: Effect.sync(() => [...currentConfigOptions()]),
            getModeState: Effect.succeed({
              currentModeId: "default",
              availableModes: [{ id: "default", name: "Default" }],
            }),
            handleSessionUpdate: (handler: SessionUpdateHandler) =>
              Effect.sync(() => {
                sessionUpdateHandler = handler;
              }),
            handleRequestPermission: (handler: PermissionHandler) =>
              Effect.sync(() => {
                permissionHandler = handler;
              }),
            handleElicitation: () => Effect.void,
            handleElicitationComplete: () => Effect.void,
            handleMcpConnect: () => Effect.void,
            handleMcpMessage: () => Effect.void,
            handleMcpDisconnect: () => Effect.void,
            handleMcpNotification: () => Effect.void,
            handleReadTextFile: () => Effect.void,
            handleWriteTextFile: () => Effect.void,
            handleCreateTerminal: () => Effect.void,
            handleTerminalOutput: () => Effect.void,
            handleTerminalWaitForExit: () => Effect.void,
            handleTerminalKill: () => Effect.void,
            handleTerminalRelease: () => Effect.void,
            handleExtRequest: () => Effect.void,
            handleExtNotification: () => Effect.void,
            handleUnknownExtRequest: () => Effect.void,
            handleUnknownExtNotification: () => Effect.void,
          } as unknown as RuntimeService;
          return runtime;
        });

      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeFakeRuntime,
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });

      const planner: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"] = {
        instanceId,
        model: "gemini-4-neon",
        options: [{ id: "effort", value: "high" }],
      };
      const builder: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"] = {
        instanceId,
        model: "gemini-4-hydrogen",
        options: [{ id: "effort", value: "high" }],
      };

      const outcomes: Array<ProviderAdapter.ProviderAdapterV2EcoOutcome> = [];
      const outcomeRecorded = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2EcoOutcome>();

      return {
        adapter,
        instanceId,
        threadId,
        mcpSessions,
        planner,
        builder,
        runtimeHttpHeaders,
        runtimeStdioEnv,
        runtimeProcessEnv,
        configChanges,
        promptsSeen,
        getCurrentModel: () => currentModel,
        outcomes,
        outcomeRecorded,
        recordOutcome: (outcome: ProviderAdapter.ProviderAdapterV2EcoOutcome) =>
          Effect.sync(() => {
            outcomes.push(outcome);
          }).pipe(Effect.andThen(Deferred.succeed(outcomeRecorded, outcome).pipe(Effect.ignore))),
      };
    });

  const permOptions: ReadonlyArray<EffectAcpSchema.PermissionOption> = [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
  ];

  it.effect(
    "runs happy-path Neon -> Hydrogen two-prompt handoff, enforces edit guard, emits plan/notice, restores planner, and records split usage",
    () =>
      Effect.gen(function* () {
        const permDecisions: Array<unknown> = [];
        let handoffReply: { readonly ok: boolean; readonly message: string } | undefined;
        let duplicateHandoffReply: { readonly ok: boolean; readonly message: string } | undefined;

        const harness = yield* makeEcoHarness({
          onPrompt: ({ promptIndex, requestPermission, threadId, mcpSessions }) =>
            Effect.gen(function* () {
              if (promptIndex === 1) {
                // Planner edit guard denies edit & write shell, allows read-only shell.
                const editRes = yield* requestPermission({
                  sessionId: "acp-eco-session-1",
                  options: permOptions,
                  toolCall: { toolCallId: "tc-edit-1", kind: "edit", title: "edit_file" },
                });
                permDecisions.push(
                  editRes.outcome.outcome === "selected" ? editRes.outcome.optionId : "cancelled",
                );
                const rmRes = yield* requestPermission({
                  sessionId: "acp-eco-session-1",
                  options: permOptions,
                  toolCall: {
                    toolCallId: "tc-rm-1",
                    kind: "execute",
                    title: "Run command",
                    rawInput: { CommandLine: "rm -rf dist" },
                  },
                });
                permDecisions.push(
                  rmRes.outcome.outcome === "selected" ? rmRes.outcome.optionId : "cancelled",
                );
                const statusRes = yield* requestPermission({
                  sessionId: "acp-eco-session-1",
                  options: permOptions,
                  toolCall: {
                    toolCallId: "tc-git-1",
                    kind: "execute",
                    title: "Run command",
                    rawInput: { CommandLine: "git status" },
                  },
                });
                permDecisions.push(
                  statusRes.outcome.outcome === "selected"
                    ? statusRes.outcome.optionId
                    : "cancelled",
                );

                // Call eco_handoff once; second call is refused; edits remain blocked until Prompt #1 ends.
                handoffReply = yield* mcpSessions.callEcoHandoff(
                  threadId,
                  "## Goal\nShip Gemini Eco",
                );
                duplicateHandoffReply = yield* mcpSessions.callEcoHandoff(
                  threadId,
                  "## Goal\nSecond plan",
                );
                const postHandoffEdit = yield* requestPermission({
                  sessionId: "acp-eco-session-1",
                  options: permOptions,
                  toolCall: { toolCallId: "tc-edit-2", kind: "edit", title: "edit_file" },
                });
                permDecisions.push(
                  postHandoffEdit.outcome.outcome === "selected"
                    ? postHandoffEdit.outcome.optionId
                    : "cancelled",
                );
                return {
                  stopReason: "end_turn",
                  usage: {
                    totalTokens: 500,
                    inputTokens: 100,
                    cachedReadTokens: 300,
                    cachedWriteTokens: 50,
                    outputTokens: 50,
                  },
                };
              }
              // Prompt #2 (builder): edits are now unlocked!
              const builderEdit = yield* requestPermission({
                sessionId: "acp-eco-session-1",
                options: permOptions,
                toolCall: { toolCallId: "tc-edit-3", kind: "edit", title: "edit_file" },
              });
              permDecisions.push(
                builderEdit.outcome.outcome === "selected"
                  ? builderEdit.outcome.optionId
                  : "cancelled",
              );
              return {
                stopReason: "end_turn",
                usage: {
                  totalTokens: 1200,
                  inputTokens: 200,
                  cachedReadTokens: 800,
                  cachedWriteTokens: 0,
                  outputTokens: 200,
                },
              };
            }),
        });

        const session = yield* harness.adapter.openSession({
          threadId: harness.threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-eco"),
          modelSelection: harness.planner,
          runtimePolicy: ecoPolicy,
          personal: {
            personalBot: true,
            personalTaskChat: true,
            ecoForTurn: () =>
              Effect.succeed({
                planner: harness.planner,
                builder: harness.builder,
                record: harness.recordOutcome,
              }),
          },
        });
        const collectedEvents: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const terminalSeen = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              collectedEvents.push(event);
            }).pipe(
              Effect.andThen(
                event.type === "turn.terminal"
                  ? Deferred.succeed(terminalSeen, event).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          ),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId: harness.threadId,
          modelSelection: harness.planner,
          runtimePolicy: ecoPolicy,
        });
        yield* session.startTurn(
          makeEcoTurnInput({
            threadId: harness.threadId,
            providerThread,
            instanceId: harness.instanceId,
            runtimePolicy: ecoPolicy,
            modelSelection: harness.planner,
            now: yield* DateTime.now,
            messageId: MessageId.make("personal-task-eco-1"),
            text: "Implement feature X",
          }),
        );
        const terminal = yield* Deferred.await(terminalSeen);
        const outcome = yield* Deferred.await(harness.outcomeRecorded);

        assert.equal(terminal.type === "turn.terminal" ? terminal.status : null, "completed");
        // Initial runtime had no t3-eco header or stdio env; restarted Eco runtime has both.
        assert.isFalse(
          harness.runtimeHttpHeaders[0]?.some((h) => h.name === "t3-eco" && h.value === "1"),
        );
        assert.isTrue(
          harness.runtimeHttpHeaders[1]?.some((h) => h.name === "t3-eco" && h.value === "1"),
        );
        assert.isFalse(
          harness.runtimeStdioEnv[0]?.some((e) => e.name === "T3_ACP_MCP_ECO" && e.value === "1"),
        );
        assert.isTrue(
          harness.runtimeStdioEnv[1]?.some((e) => e.name === "T3_ACP_MCP_ECO" && e.value === "1"),
        );
        assert.isUndefined(harness.runtimeProcessEnv[0]?.T3_ACP_MCP_ECO);
        assert.equal(harness.runtimeProcessEnv[1]?.T3_ACP_MCP_ECO, "1");
        assert.deepEqual(handoffReply, { ok: true, message: ECO_ACP_HANDOFF_PLANNER_ACK });
        assert.isFalse(duplicateHandoffReply?.ok);
        // Edit, rm -rf, and post-handoff-in-prompt-1 edit were denied; git status and builder edit were allowed.
        assert.deepEqual(permDecisions, [
          "reject_once",
          "reject_once",
          "allow_once",
          "reject_once",
          "allow_once",
        ]);
        // Prompt #1 ran on Neon with <eco_mode>; Prompt #2 ran on Hydrogen with <eco_builder>.
        assert.equal(harness.promptsSeen.length, 2);
        assert.equal(harness.promptsSeen[0]?.model, "gemini-4-neon");
        assert.include(harness.promptsSeen[0]?.text ?? "", "<eco_mode>");
        assert.equal(harness.promptsSeen[1]?.model, "gemini-4-hydrogen");
        assert.include(harness.promptsSeen[1]?.text ?? "", "<eco_builder>");
        assert.include(harness.promptsSeen[1]?.text ?? "", "## Goal\nShip Gemini Eco");
        // Planner model was restored on turn end.
        assert.equal(harness.getCurrentModel(), "gemini-4-neon");
        // Emitted proposed_plan and system_notice.
        assert.isTrue(
          collectedEvents.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "proposed_plan" &&
              e.turnItem.status === "completed" &&
              e.turnItem.markdown.includes("**Handed off to gemini-4-hydrogen**"),
          ),
        );
        assert.isTrue(
          collectedEvents.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "system_notice" &&
              e.turnItem.title === "Handed off to gemini-4-hydrogen",
          ),
        );
        // Outcome recorded with provider: "antigravity" and exact planner vs builder split.
        assert.equal(outcome.provider, "antigravity");
        assert.isTrue(outcome.handedOff);
        assert.equal(outcome.status, "completed");
        assert.equal(outcome.plan, "## Goal\nShip Gemini Eco");
        assert.equal(outcome.planner.model, "gemini-4-neon");
        assert.equal(outcome.planner.inputTokens, 100);
        assert.equal(outcome.planner.cacheReadTokens, 300);
        assert.equal(outcome.planner.outputTokens, 50);
        assert.equal(outcome.planner.calls, 1);
        assert.equal(outcome.builder.model, "gemini-4-hydrogen");
        assert.equal(outcome.builder.inputTokens, 200);
        assert.equal(outcome.builder.cacheReadTokens, 800);
        assert.equal(outcome.builder.outputTokens, 200);
        assert.equal(outcome.builder.calls, 1);
        // Handler is unregistered after turn ends.
        const lateHandoff = yield* harness.mcpSessions.callEcoHandoff(harness.threadId, "late");
        assert.isFalse(lateHandoff.ok);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("completes a no-handoff read-only Eco turn without switching to builder", () =>
    Effect.gen(function* () {
      const harness = yield* makeEcoHarness({
        onPrompt: () =>
          Effect.succeed({
            stopReason: "end_turn",
            usage: { totalTokens: 300, inputTokens: 150, cachedReadTokens: 100, outputTokens: 50 },
          }),
      });
      const session = yield* harness.adapter.openSession({
        threadId: harness.threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-eco"),
        modelSelection: harness.planner,
        runtimePolicy: ecoPolicy,
        personal: {
          personalBot: true,
          personalTaskChat: true,
          ecoForTurn: () =>
            Effect.succeed({
              planner: harness.planner,
              builder: harness.builder,
              record: harness.recordOutcome,
            }),
        },
      });
      const providerThread = yield* session.ensureThread({
        threadId: harness.threadId,
        modelSelection: harness.planner,
        runtimePolicy: ecoPolicy,
      });
      yield* session.startTurn(
        makeEcoTurnInput({
          threadId: harness.threadId,
          providerThread,
          instanceId: harness.instanceId,
          runtimePolicy: ecoPolicy,
          modelSelection: harness.planner,
          now: yield* DateTime.now,
          messageId: MessageId.make("personal-task-eco-ro"),
          text: "Summarize README",
        }),
      );
      const outcome = yield* Deferred.await(harness.outcomeRecorded);
      assert.equal(harness.promptsSeen.length, 1);
      assert.isFalse(outcome.handedOff);
      assert.equal(outcome.status, "completed");
      assert.equal(outcome.planner.inputTokens, 150);
      assert.equal(outcome.builder.inputTokens, 0);
      assert.equal(outcome.builder.calls, 0);
      assert.equal(harness.getCurrentModel(), "gemini-4-neon");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("reverts to planner and records handoffError when builder switch fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeEcoHarness({
        onPrompt: ({ threadId, mcpSessions }) =>
          Effect.gen(function* () {
            yield* mcpSessions.callEcoHandoff(threadId, "## Goal\nBuild it");
            return {
              stopReason: "end_turn",
              usage: { totalTokens: 200, inputTokens: 100, outputTokens: 100 },
            };
          }),
        onSetConfigOption: (id, value) =>
          id === "model" && value === "gemini-4-hydrogen"
            ? Effect.fail(EffectAcpErrors.AcpRequestError.internalError("builder unavailable"))
            : Effect.void,
      });
      const session = yield* harness.adapter.openSession({
        threadId: harness.threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-eco"),
        modelSelection: harness.planner,
        runtimePolicy: ecoPolicy,
        personal: {
          personalBot: true,
          personalTaskChat: true,
          ecoForTurn: () =>
            Effect.succeed({
              planner: harness.planner,
              builder: harness.builder,
              record: harness.recordOutcome,
            }),
        },
      });
      const collectedEvents: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* session.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            collectedEvents.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId: harness.threadId,
        modelSelection: harness.planner,
        runtimePolicy: ecoPolicy,
      });
      yield* session.startTurn(
        makeEcoTurnInput({
          threadId: harness.threadId,
          providerThread,
          instanceId: harness.instanceId,
          runtimePolicy: ecoPolicy,
          modelSelection: harness.planner,
          now: yield* DateTime.now,
          messageId: MessageId.make("personal-task-eco-fail-switch"),
          text: "Build feature",
        }),
      );
      const outcome = yield* Deferred.await(harness.outcomeRecorded);
      assert.equal(harness.promptsSeen.length, 1);
      assert.isFalse(outcome.handedOff);
      assert.include(outcome.handoffError ?? "", "builder unavailable");
      assert.equal(harness.getCurrentModel(), "gemini-4-neon");
      assert.isTrue(
        collectedEvents.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "system_notice" &&
            e.turnItem.title?.includes("Eco handoff to gemini-4-hydrogen failed"),
        ),
      );
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "handles interrupt before handoff and after handoff, restoring planner and unregistering handler",
    () =>
      Effect.gen(function* () {
        // Part 1: interrupt before handoff (during Prompt #1)
        const prompt1Started = yield* Deferred.make<void>();
        const prompt1Cancel = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        const harness1 = yield* makeEcoHarness({
          onPrompt: () =>
            Deferred.succeed(prompt1Started, undefined).pipe(
              Effect.andThen(Deferred.await(prompt1Cancel)),
            ),
          onCancel: () =>
            Deferred.succeed(prompt1Cancel, { stopReason: "cancelled" }).pipe(Effect.asVoid),
        });
        const session1 = yield* harness1.adapter.openSession({
          threadId: harness1.threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-eco-int1"),
          modelSelection: harness1.planner,
          runtimePolicy: ecoPolicy,
          personal: {
            personalBot: true,
            personalTaskChat: true,
            ecoForTurn: () =>
              Effect.succeed({
                planner: harness1.planner,
                builder: harness1.builder,
                record: harness1.recordOutcome,
              }),
          },
        });
        const turnStarted1 = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session1.events.pipe(
          Stream.runForEach((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running"
              ? Deferred.succeed(turnStarted1, event).pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const thread1 = yield* session1.ensureThread({
          threadId: harness1.threadId,
          modelSelection: harness1.planner,
          runtimePolicy: ecoPolicy,
        });
        yield* session1.startTurn(
          makeEcoTurnInput({
            threadId: harness1.threadId,
            providerThread: thread1,
            instanceId: harness1.instanceId,
            runtimePolicy: ecoPolicy,
            modelSelection: harness1.planner,
            now: yield* DateTime.now,
            messageId: MessageId.make("personal-task-eco-int1"),
            text: "Investigate",
          }),
        );
        const startedEvt1 = yield* Deferred.await(turnStarted1);
        yield* Deferred.await(prompt1Started);
        yield* session1.interruptTurn({
          providerThread: thread1,
          providerTurnId:
            startedEvt1.type === "provider_turn.updated"
              ? startedEvt1.providerTurn.id
              : ("" as never),
        });
        const outcome1 = yield* Deferred.await(harness1.outcomeRecorded);
        assert.equal(outcome1.status, "interrupted");
        assert.isFalse(outcome1.handedOff);
        assert.isFalse((yield* harness1.mcpSessions.callEcoHandoff(harness1.threadId, "x")).ok);

        // Part 2: interrupt after handoff (during Prompt #2 on builder)
        const prompt2Started = yield* Deferred.make<void>();
        const prompt2Cancel = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
        const harness2 = yield* makeEcoHarness({
          onPrompt: ({ promptIndex, threadId, mcpSessions }) =>
            promptIndex === 1
              ? mcpSessions
                  .callEcoHandoff(threadId, "## Goal\nDo work")
                  .pipe(Effect.as({ stopReason: "end_turn" as const }))
              : Deferred.succeed(prompt2Started, undefined).pipe(
                  Effect.andThen(Deferred.await(prompt2Cancel)),
                ),
          onCancel: () =>
            Deferred.succeed(prompt2Cancel, { stopReason: "cancelled" }).pipe(Effect.asVoid),
        });
        const session2 = yield* harness2.adapter.openSession({
          threadId: harness2.threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-eco-int2"),
          modelSelection: harness2.planner,
          runtimePolicy: ecoPolicy,
          personal: {
            personalBot: true,
            personalTaskChat: true,
            ecoForTurn: () =>
              Effect.succeed({
                planner: harness2.planner,
                builder: harness2.builder,
                record: harness2.recordOutcome,
              }),
          },
        });
        const turnStarted2 = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session2.events.pipe(
          Stream.runForEach((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running"
              ? Deferred.succeed(turnStarted2, event).pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const thread2 = yield* session2.ensureThread({
          threadId: harness2.threadId,
          modelSelection: harness2.planner,
          runtimePolicy: ecoPolicy,
        });
        yield* session2.startTurn(
          makeEcoTurnInput({
            threadId: harness2.threadId,
            providerThread: thread2,
            instanceId: harness2.instanceId,
            runtimePolicy: ecoPolicy,
            modelSelection: harness2.planner,
            now: yield* DateTime.now,
            messageId: MessageId.make("personal-task-eco-int2"),
            text: "Build feature",
          }),
        );
        const startedEvt2 = yield* Deferred.await(turnStarted2);
        yield* Deferred.await(prompt2Started);
        assert.equal(harness2.getCurrentModel(), "gemini-4-hydrogen");
        yield* session2.interruptTurn({
          providerThread: thread2,
          providerTurnId:
            startedEvt2.type === "provider_turn.updated"
              ? startedEvt2.providerTurn.id
              : ("" as never),
        });
        const outcome2 = yield* Deferred.await(harness2.outcomeRecorded);
        assert.equal(outcome2.status, "interrupted");
        assert.isTrue(outcome2.handedOff);
        assert.equal(harness2.getCurrentModel(), "gemini-4-neon");
        assert.isFalse((yield* harness2.mcpSessions.callEcoHandoff(harness2.threadId, "x")).ok);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "skips Eco with eco_skipped when builder is unfit, and leaves non-Eco chat turns unaffected",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeEcoHarness({
          onPrompt: () => Effect.succeed({ stopReason: "end_turn" }),
        });
        let turnKind: "chat" | "unfit" = "chat";
        const session = yield* harness.adapter.openSession({
          threadId: harness.threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-eco"),
          modelSelection: harness.planner,
          runtimePolicy: ecoPolicy,
          personal: {
            personalBot: true,
            personalTaskChat: false,
            ecoForTurn: () =>
              turnKind === "chat"
                ? Effect.undefined
                : Effect.succeed({
                    planner: harness.planner,
                    builder: harness.planner,
                    record: harness.recordOutcome,
                  }),
          },
        });
        const terminals = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Queue.offer(terminals, event) : Effect.void,
          ),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId: harness.threadId,
          modelSelection: harness.planner,
          runtimePolicy: ecoPolicy,
        });

        // Turn 1: non-Eco chat turn -> no runtime restart, no t3-eco header, no <eco_mode>, no outcome.
        yield* session.startTurn(
          makeEcoTurnInput({
            threadId: harness.threadId,
            providerThread,
            instanceId: harness.instanceId,
            runtimePolicy: ecoPolicy,
            modelSelection: harness.planner,
            now: yield* DateTime.now,
            messageId: MessageId.make("msg-chat-1"),
            text: "Hello chat",
          }),
        );
        yield* Queue.take(terminals);
        assert.equal(harness.runtimeHttpHeaders.length, 1);
        assert.notInclude(harness.promptsSeen[0]?.text ?? "", "<eco_mode>");
        assert.equal(harness.outcomes.length, 0);

        // Turn 2: unfit builder (same model) -> skips Eco without restarting runtime and records eco_skipped.
        turnKind = "unfit";
        yield* session.startTurn(
          makeEcoTurnInput({
            threadId: harness.threadId,
            providerThread,
            instanceId: harness.instanceId,
            runtimePolicy: ecoPolicy,
            modelSelection: harness.planner,
            now: yield* DateTime.now,
            messageId: MessageId.make("personal-task-unfit"),
            text: "Unfit builder task",
            runId: RunId.make("run-unfit"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.take(terminals);
        const outcome = yield* Deferred.await(harness.outcomeRecorded);
        assert.equal(harness.runtimeHttpHeaders.length, 1);
        assert.notInclude(harness.promptsSeen[1]?.text ?? "", "<eco_mode>");
        assert.equal(outcome.ecoSkipped, "builder_same_model");
        assert.isFalse(outcome.handedOff);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect(
    "blocks runtime restart and skips Eco with background_work when background work is active",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeEcoHarness({
          onPrompt: () => Effect.succeed({ stopReason: "end_turn" }),
        });
        yield* harness.mcpSessions.set({
          environmentId: EnvironmentId.make("env-eco"),
          threadId: harness.threadId,
          providerSessionId: "provider-session-antigravity-eco",
          providerInstanceId: harness.instanceId,
          endpoint: "http://127.0.0.1:4321/mcp",
          authorizationHeader: "Bearer test-token",
          browserToolsAvailable: false,
          hasPendingWake: Effect.succeed(true),
        });
        const session = yield* harness.adapter.openSession({
          threadId: harness.threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-eco"),
          modelSelection: harness.planner,
          runtimePolicy: ecoPolicy,
          personal: {
            personalBot: true,
            personalTaskChat: true,
            ecoForTurn: () =>
              Effect.succeed({
                planner: harness.planner,
                builder: harness.builder,
                record: harness.recordOutcome,
              }),
          },
        });
        const providerThread = yield* session.ensureThread({
          threadId: harness.threadId,
          modelSelection: harness.planner,
          runtimePolicy: ecoPolicy,
        });
        yield* session.startTurn(
          makeEcoTurnInput({
            threadId: harness.threadId,
            providerThread,
            instanceId: harness.instanceId,
            runtimePolicy: ecoPolicy,
            modelSelection: harness.planner,
            now: yield* DateTime.now,
            messageId: MessageId.make("personal-task-eco-bg"),
            text: "Task with background work",
          }),
        );
        const outcome = yield* Deferred.await(harness.outcomeRecorded);
        // Runtime was NOT restarted (still 1 runtime, no t3-eco header or stdio env).
        assert.equal(harness.runtimeHttpHeaders.length, 1);
        assert.isFalse(
          harness.runtimeHttpHeaders[0]?.some((h) => h.name === "t3-eco" && h.value === "1"),
        );
        assert.isFalse(
          harness.runtimeStdioEnv[0]?.some((e) => e.name === "T3_ACP_MCP_ECO" && e.value === "1"),
        );
        assert.isUndefined(harness.runtimeProcessEnv[0]?.T3_ACP_MCP_ECO);
        assert.notInclude(harness.promptsSeen[0]?.text ?? "", "<eco_mode>");
        assert.equal(outcome.ecoSkipped, "background_work");
        assert.isFalse(outcome.handedOff);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
