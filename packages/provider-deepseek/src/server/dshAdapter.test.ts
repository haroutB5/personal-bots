// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The dsh flavour against the real ACP runtime, driving `dshTestAgent.ts`.
 * The fake agent replays the recorded handshake and turn shapes; assertions
 * read the v2 event projection a chat sees, not adapter internals.
 */
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  imageByteLimitForModel,
  type ChatAttachment,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import { DeepSeekSettings } from "../settings.ts";
import { dshImageTooLargeText, makeDeepSeekDshAdapter, translateDshFailure } from "./dshAdapter.ts";
import { dshTestAgentPath } from "./dshTestAgent.ts";

const instanceId = ProviderInstanceId.make("deepseek-dsh-test");
const threadId = ThreadId.make("dsh-thread");
const nativeSessionId = "mock-session-1";

const decodeSettings = Schema.decodeSync(DeepSeekSettings);
const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
});

const testLayer = TestProviderHost.layer().pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      IdAllocator.layer,
      McpProviderSessions.layer,
    ),
  ),
);

const captureWarnLines = () => {
  const lines: Array<{ readonly text: string; readonly fields: Record<string, unknown> }> = [];
  const sink = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel !== "Warn") return;
    const [text, fields] = Array.isArray(message) ? message : [message, {}];
    lines.push({ text: String(text), fields: (fields ?? {}) as Record<string, unknown> });
  });
  return { lines, layer: Logger.layer([sink], { mergeWithExisting: false }) };
};

interface HarnessOptions {
  readonly promptError?: string;
  readonly resumeFails?: boolean;
  readonly registerProcess?: (input: {
    readonly threadId: string;
    readonly provider: string;
    readonly pid: number;
  }) => void;
  readonly forgetProcess?: (threadId: string, pid?: number) => void;
}

interface LoggedRequest {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const makeHarness = Effect.fn("makeDshHarness")(function* (options: HarnessOptions = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-agent-" });
  const dshHome = path.join(baseDir, "dsh");
  const requestLog = path.join(baseDir, "requests.ndjson");
  const settings = decodeSettings({
    enabled: true,
    engine: "dsh",
    dshRuntimePath: path.join(baseDir, "runtime"),
  });
  const adapter = yield* makeDeepSeekDshAdapter({
    instanceId,
    settings,
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    dshHome,
    ...(options.registerProcess === undefined ? {} : { registerProcess: options.registerProcess }),
    ...(options.forgetProcess === undefined ? {} : { forgetProcess: options.forgetProcess }),
    spawnForTest: ({ environment, cwd }) => ({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", dshTestAgentPath],
      cwd,
      env: {
        ...process.env,
        ...environment,
        T3_ACP_REQUEST_LOG_PATH: requestLog,
        ...(options.promptError === undefined
          ? {}
          : { T3_ACP_DSH_PROMPT_ERROR: options.promptError }),
        ...(options.resumeFails === true ? { T3_ACP_DSH_RESUME_FAIL: "1" } : {}),
      },
      extendEnv: false,
    }),
  });
  const requests = (): ReadonlyArray<LoggedRequest> => {
    if (!NodeFS.existsSync(requestLog)) return [];
    return NodeFS.readFileSync(requestLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LoggedRequest);
  };
  const patch = (): ReadonlyArray<Record<string, unknown>> | undefined => {
    const file = path.join(dshHome, "launch", `${threadId}.json`);
    if (!NodeFS.existsSync(file)) return undefined;
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as ReadonlyArray<Record<string, unknown>>;
  };
  return {
    adapter,
    dshHome,
    host,
    requests,
    patch,
  };
});

const openInput = (input: {
  readonly model?: string;
  readonly selectionOptions?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly initialNativeThreadId?: string;
  readonly personalBotId?: string;
  readonly systemInstructions?: string;
}) => ({
  threadId,
  providerSessionId: ProviderSessionId.make("provider-session-dsh"),
  modelSelection: {
    instanceId,
    model: input.model ?? "deepseek-flash",
    ...(input.selectionOptions === undefined ? {} : { options: input.selectionOptions }),
  },
  runtimePolicy,
  ...(input.initialNativeThreadId === undefined
    ? {}
    : { initialNativeThreadId: input.initialNativeThreadId }),
  ...(input.systemInstructions === undefined
    ? {}
    : { systemInstructions: input.systemInstructions }),
  ...(input.personalBotId === undefined
    ? {}
    : {
        personal: {
          personalBot: true,
          personalBotId: input.personalBotId,
          personalTaskChat: false,
        },
      }),
});

const turnInput = (input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly selectionOptions?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const modelSelection = {
      instanceId,
      model: "deepseek-flash",
      ...(input.selectionOptions === undefined ? {} : { options: input.selectionOptions }),
    };
    return {
      appThread: {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make(`project:${threadId}`),
        title: "dsh adapter test",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: runtimePolicy.runtimeMode,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: input.providerThread.id,
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
      runId: RunId.make(`run:${threadId}:1`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt:${threadId}:1`),
      rootNodeId: NodeId.make(`node:${threadId}:1`),
      providerThread: input.providerThread,
      message: {
        createdBy: "user" as const,
        creationSource: "web" as const,
        messageId: MessageId.make(`message:${threadId}:1`),
        text: input.text,
        attachments: input.attachments ?? [],
      },
      modelSelection,
      runtimePolicy,
    };
  });

const collectTurn = (session: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  session.events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
    Effect.map((events) => [...events]),
  );

const assistantTexts = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" &&
    event.turnItem.type === "assistant_message" &&
    event.turnItem.streaming === false
      ? [event.turnItem.text]
      : [],
  );

const reasoningTexts = (
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" &&
    event.turnItem.type === "reasoning" &&
    event.turnItem.streaming === false
      ? [event.turnItem.text]
      : [],
  );

it.layer(testLayer)("DeepSeekDshAdapter", (it) => {
  it.effect(
    "starts a dsh session with the recorded handshake, the t3-code MCP entry and reasoning effort",
    () =>
      Effect.gen(function* () {
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        yield* mcpSessions.set({
          environmentId: EnvironmentId.make("dsh-test-environment"),
          threadId,
          providerSessionId: nativeSessionId,
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:1/mcp",
          authorizationHeader: "Bearer test-token",
          browserToolsAvailable: false,
        });
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const session = yield* harness.adapter.openSession(
            openInput({ selectionOptions: [{ id: "effort", value: "xhigh" }] }),
          );
          expect(session.driver).toBe("deepseek");
          expect(session.providerSession.status).toBe("ready");
          const methods = harness.requests().map((request) => request.method);
          // Never `session/load`: dsh answers with `session/resume`.
          expect(methods).not.toContain("session/load");
          expect(methods.slice(0, 2)).toEqual(["initialize", "auth/login"]);
          const newSession = harness.requests().find((request) => request.method === "session/new");
          expect(newSession?.params?.["cwd"]).toBe(runtimePolicy.cwd);
          expect(newSession?.params?.["mcpServers"]).toEqual([
            {
              type: "http",
              name: "t3-code",
              url: "http://127.0.0.1:1/mcp",
              headers: [{ name: "Authorization", value: "Bearer test-token" }],
            },
          ]);
          const setOption = harness
            .requests()
            .find((request) => request.method === "session/set_config_option");
          expect(setOption?.params).toMatchObject({
            configId: "reasoning_effort",
            value: "max",
          });
          const patch = harness.patch();
          expect(patch?.map((row) => row["id"])).toContain("session-log-deepseek");
        }).pipe(Effect.scoped);
      }),
  );

  it.effect("runs the recorded turn order and flushes the usage ledger", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(yield* turnInput({ providerThread, text: "do the three steps" }));
        const events = yield* collectTurn(session);
        expect(events[0]?.type).toBe("provider_turn.updated");
        const terminal = events.at(-1);
        expect(terminal?.type).toBe("turn.terminal");
        expect(terminal?.type === "turn.terminal" ? terminal.status : undefined).toBe("completed");
        // One context-meter update per committed step, three steps in the recording.
        const usage = events.filter(
          (event) =>
            event.type === "provider_thread.updated" &&
            (event.providerThread.contextUsage?.usedTokens ?? 0) > 0,
        );
        expect(
          usage
            .map((event) =>
              event.type === "provider_thread.updated"
                ? event.providerThread.contextUsage?.usedTokens
                : undefined,
            )
            .filter((used, index, all) => used !== all[index - 1]),
        ).toEqual([1_000, 1_500, 2_000]);
        const toolTitles = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
            ? [event.turnItem.title]
            : [],
        );
        expect(toolTitles).toContain("Saving a note");
        expect(toolTitles).toContain("skill");
        const text = JSON.stringify(events);
        expect(text).toContain("ECHO:HELLO DSH FALCON-42");
        expect(assistantTexts(events)).toEqual(["ECHO:HELLO DSH FALCON-42"]);
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("starts a new reasoning paragraph when a thought follows a tool call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(yield* turnInput({ providerThread, text: "paragraph-probe" }));
        const events = yield* collectTurn(session);
        expect(reasoningTexts(events).join("")).toBe("Let me check the file.\n\nThe file is fine.");
        expect(assistantTexts(events)).toEqual(["Done."]);
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("strips leaked tool-call markup from a reply, and warns about its tool", () => {
    const logs = captureWarnLines();
    return Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(
          openInput({ personalBotId: "bot-one", systemInstructions: "Be brief." }),
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(yield* turnInput({ providerThread, text: "dsml-probe" }));
        const events = yield* collectTurn(session);
        expect(assistantTexts(events).join("")).toBe("Before.After.");
        expect(JSON.stringify(events)).not.toContain("DSML");
        const warnings = logs.lines.filter(
          (line) => line.text === "Removed DeepSeek tool-call markup from a bot reply",
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
          fields: { threadId, botId: "bot-one", tool: "web_search" },
        });
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("settles a stub line's colon with a full stop, before the tool call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(yield* turnInput({ providerThread, text: "colon-probe" }));
        const events = yield* collectTurn(session);
        expect(assistantTexts(events).join("")).toBe("Now the provider.Done.");
        expect(JSON.stringify(events)).toContain("dsh-colon-probe-call");
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("settles a cancelled turn with the aborted tool, never a second prompt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const toolStarted = yield* Deferred.make<void>();
        const collector = yield* session.events.pipe(
          Stream.tap((event) =>
            Effect.sync(() => seen.push(event)).pipe(
              Effect.andThen(
                event.type === "turn_item.updated"
                  ? Deferred.succeed(toolStarted, undefined)
                  : Effect.void,
              ),
            ),
          ),
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* session.startTurn(
          yield* turnInput({
            providerThread,
            text: "Run this exact PowerShell command: Start-Sleep -Seconds 60",
          }),
        );
        yield* Deferred.await(toolStarted);
        const turn = seen.find((event) => event.type === "provider_turn.updated");
        if (turn?.type !== "provider_turn.updated") throw new Error("no running turn");
        yield* session.interruptTurn({
          providerThread,
          providerTurnId: turn.providerTurn.id,
        });
        yield* Fiber.join(collector);
        const terminal = seen.at(-1);
        expect(terminal?.type === "turn.terminal" ? terminal.status : undefined).toBe(
          "interrupted",
        );
        expect(JSON.stringify(seen)).toContain("Error: tool call aborted");
        const methods = harness.requests().map((request) => request.method);
        expect(methods).toContain("session/cancel");
        expect(methods.filter((method) => method === "session/prompt")).toHaveLength(1);
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("resumes with the cursor's pinned mode even when the turn asks for another", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(
          openInput({
            initialNativeThreadId: nativeSessionId,
            selectionOptions: [{ id: "agentMode", value: "standard" }],
          }),
        );
        const resume = harness.requests().find((request) => request.method === "session/resume");
        expect(resume?.params?.["sessionId"]).toBe(nativeSessionId);
        expect(harness.requests().map((request) => request.method)).not.toContain("session/new");
        const patch = harness.patch();
        const rowIds = (patch ?? []).map((row) => row["id"]);
        expect(rowIds).not.toContain("tools");
        expect(rowIds).toContain("session-log-deepseek");
        expect(NodeFS.existsSync(path.join(harness.dshHome, "launch", `${threadId}.json`))).toBe(
          true,
        );
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        // The turn asks for Code; the resumed session stays Standard.
        yield* session.startTurn(
          yield* turnInput({
            providerThread,
            text: "hello",
            selectionOptions: [{ id: "agentMode", value: "code" }],
          }),
        );
        yield* collectTurn(session);
        expect((harness.patch() ?? []).map((row) => row["id"])).not.toContain("tools");
      }).pipe(Effect.scoped);
      expect(NodeFS.existsSync(path.join(harness.dshHome, "launch", `${threadId}.json`))).toBe(
        false,
      );
    }),
  );

  it.effect("fails the first turn on a cursor from another engine, so the server renews it", () =>
    Effect.gen(function* () {
      const foreignId = "b1ef3808-58f4-40ec-81ed-a9a6af7a8f65";
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(
          openInput({ initialNativeThreadId: foreignId }),
        );
        const methods = harness.requests().map((request) => request.method);
        // dsh refuses a Claude session id; v2 renews inside openSession.
        expect(methods).toContain("session/resume");
        expect(methods).toContain("session/new");
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(yield* turnInput({ providerThread, text: "hello" }));
        const events = yield* collectTurn(session);
        const terminal = events.at(-1);
        expect(terminal?.type === "turn.terminal" ? terminal.status : undefined).toBe("completed");
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("turns a dsh failure into the wording the limit handling reads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        promptError: "Internal error: turn failed: Insufficient Balance",
      });
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(yield* turnInput({ providerThread, text: "hello" }));
        const events = yield* collectTurn(session);
        const terminal = events.at(-1);
        expect(terminal?.type).toBe("turn.terminal");
        if (terminal?.type !== "turn.terminal" || terminal.status !== "failed") {
          throw new Error("expected a failed turn");
        }
        expect(terminal.failure.class).toBe("usage_limit");
        expect(terminal.failure.message).toContain("rate limit");
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("registers the harness process for the Performance tab", () =>
    Effect.gen(function* () {
      const registered: Array<{ threadId: string; provider: string; pid: number }> = [];
      const forgotten: Array<{ threadId: string; pid: number | undefined }> = [];
      const harness = yield* makeHarness({
        registerProcess: (entry) => registered.push(entry),
        forgetProcess: (threadId, pid) => forgotten.push({ threadId, pid }),
      });
      yield* Effect.gen(function* () {
        yield* harness.adapter.openSession(openInput({}));
        expect(registered).toHaveLength(1);
        expect(registered[0]?.threadId).toBe(threadId);
        expect(registered[0]?.provider).toBe("deepseek");
        expect(registered[0]?.pid).toBeGreaterThan(4);
      }).pipe(Effect.scoped);
      expect(forgotten).toEqual([{ threadId, pid: registered[0]?.pid }]);
    }),
  );

  it("the harness's own image validator overflows on the payload of the live photo", () => {
    // The exact check dsh runs before it accepts an inline image. V8's regexp
    // engine carries its own stack and walks this pattern four characters at a
    // time, so a payload past ~4.47 M characters throws.
    const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    expect(() => canonicalBase64.test(Buffer.alloc(8_449_624).toString("base64"))).toThrow(
      RangeError,
    );
    expect(
      canonicalBase64.test(Buffer.alloc(DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES).toString("base64")),
    ).toBe(true);
  });

  it.effect("refuses an image the harness cannot validate, instead of a stack-overflow turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeHarness();
      const bytes = DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES + 1;
      const attachment: ChatAttachment = {
        type: "image",
        id: "dsh-oversized-12345678-1234-1234-1234-123456789abc",
        name: "seiko.png",
        mimeType: "image/png",
        sizeBytes: bytes,
      };
      const attachmentPath = path.join(harness.host.paths.attachmentsDir, attachment.id);
      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, Buffer.alloc(bytes, 7));
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        const failure = yield* Effect.flip(
          session.startTurn(
            yield* turnInput({
              providerThread,
              text: "How much is this?",
              attachments: [attachment],
            }),
          ),
        );
        expect(JSON.stringify(failure)).toContain("DeepSeek can't read this image");
        expect(JSON.stringify(failure)).toContain("takes images up to 2.0 MB");
        expect(JSON.stringify(failure)).not.toContain("Maximum call stack");
        // The runtime never sees the payload it would have overflowed on.
        expect(harness.requests().filter((request) => request.method === "session/prompt")).toEqual(
          [],
        );
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("refuses an oversized image before any session exists, so nothing overwrites it", () =>
    Effect.sync(() => {
      const bytes = DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES + 1;
      // The pre-session guard reads this contract, before any adapter is made.
      expect(imageByteLimitForModel("deepseek-flash")).toBe(DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES);
      expect(imageByteLimitForModel("claude-opus-4-6")).toBeGreaterThan(bytes);
      expect(dshImageTooLargeText({ name: "carrier.png", bytes })).toBe(
        'DeepSeek can\'t read this image "carrier.png" (2.0 MB): the DeepSeek engine takes ' +
          "images up to 2.0 MB. Send a smaller photo, or send it to a Claude bot.",
      );
    }),
  );

  it.effect("sends a small image inline, the way a turn always has", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeHarness();
      const attachment: ChatAttachment = {
        type: "image",
        id: "dsh-small-12345678-1234-1234-1234-123456789abc",
        name: "small.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(harness.host.paths.attachmentsDir, attachment.id);
      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(
          yield* turnInput({
            providerThread,
            text: "What's in this image?",
            attachments: [attachment],
          }),
        );
        // The agent answers only after it received the prompt.
        yield* collectTurn(session);
        const prompt = harness.requests().find((request) => request.method === "session/prompt");
        const blocks = (prompt?.params as { prompt?: ReadonlyArray<unknown> } | undefined)?.prompt;
        expect(blocks).toContainEqual({
          type: "image",
          data: "AQIDBA==",
          mimeType: "image/png",
        });
      }).pipe(Effect.scoped);
    }),
  );

  it.effect("warns once for the skill a bot's plugin folder cannot load", () => {
    const logs = captureWarnLines();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const botId = "bot-one";
      const pluginDir = path.join(host.paths.baseDir, "bot-plugins", botId);
      const skillDir = path.join(pluginDir, ".claude", "skills", "bom");
      yield* fileSystem.makeDirectory(skillDir, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(pluginDir, ".claude-plugin"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(pluginDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: botId, skills: "./.claude/skills/" }),
      );
      // A UTF-8 BOM is what the harness drops in silence.
      yield* fileSystem.writeFileString(
        path.join(skillDir, "SKILL.md"),
        "\uFEFF---\nname: bom\n---\n\nBody.\n",
      );
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* harness.adapter.openSession(openInput({ personalBotId: botId }));
        const warnings = logs.lines.filter(
          (line) => line.text === "bot plugin skill failed to load",
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatchObject({
          fields: {
            botId,
            path: path.join(skillDir, "SKILL.md"),
            reason: expect.stringContaining("UTF-8 BOM"),
          },
        });
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("translates the failure wordings dsh reports", () =>
    Effect.sync(() => {
      expect(translateDshFailure("Internal error: turn failed: Insufficient Balance")).toEqual({
        text: expect.stringContaining("rate limit"),
        rateLimited: true,
      });
      expect(translateDshFailure("Turn failed: Too Many Requests").rateLimited).toBe(true);
      expect(
        translateDshFailure("Authentication Fails, Your api key: ****-key is invalid").text,
      ).toContain("API key saved in this DeepSeek");
      expect(
        translateDshFailure("Authentication Fails, Your api key: ****-key is invalid").text,
      ).not.toContain("ANTHROPIC_AUTH_TOKEN");
      expect(translateDshFailure("Internal error: turn failed: boom").text).toBe(
        "DeepSeek turn failed: boom",
      );
      // The live failure of 14 Oct: dsh's own stack overflow, with our stack
      // trace under it. It never reaches the chat in those words.
      const overflow = translateDshFailure(
        "Error: Internal error: prompt was not queued: Maximum call stack size exceeded\n" +
          "    at decodeJsonError (file:///C:/.../bin.mjs:1:1)\n" +
          "    at DeepSeekDshAdapter.beginTurnLocked (file:///C:/.../bin.mjs:2:2)",
      );
      expect(overflow.text).toContain("ran out of stack");
      expect(overflow.text).not.toContain("Maximum call stack");
      expect(overflow.rateLimited).toBe(false);
      expect(translateDshFailure("something else").rateLimited).toBe(false);
    }),
  );

  it.effect("maps a recorded dsh turn onto v2 events with the deepseek driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const session = yield* harness.adapter.openSession(openInput({}));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "deepseek-flash" },
          runtimePolicy,
        });
        yield* session.startTurn(yield* turnInput({ providerThread, text: "do the three steps" }));
        const events = yield* collectTurn(session);
        const types = new Set(events.map((event) => event.type));
        expect(types.has("message.updated")).toBe(true);
        expect(types.has("turn_item.updated")).toBe(true);
        expect(types.has("turn.terminal")).toBe(true);
        expect(events.every((event) => event.driver === "deepseek")).toBe(true);
        expect(JSON.stringify(events)).not.toContain("claudeAgent");
      }).pipe(Effect.scoped);
    }),
  );
});
