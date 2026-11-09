// DeepSeek's claude-code wrapper: Flash-only gating, `deepseek` identity on
// sessions/events/errors, and DeepSeek-worded failures. The inner Claude
// adapter is a fake, because this file tests the wrapper's boundary.
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import { DeepSeekSettings } from "../settings.ts";
import {
  deepSeekClaudeSettings,
  deepSeekFailureText,
  makeDeepSeekClaudeAdapter,
  type DeepSeekClaudeAdapterFactoryInput,
} from "./adapter.ts";

const DEEPSEEK = ProviderDriverKind.make("deepseek");
const CLAUDE_AGENT = ProviderDriverKind.make("claudeAgent");
const INSTANCE = ProviderInstanceId.make("deepseek");
const THREAD_ID = ThreadId.make("thread-deepseek-claude");
const PROVIDER_THREAD_ID = ProviderThreadId.make("provider-thread-deepseek-claude");

const settings = Schema.decodeSync(DeepSeekSettings)({
  enabled: true,
  engine: "claude-code",
  binaryPath: "claude",
  homePath: "",
});

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/tmp",
});

const openInput = (model = "deepseek-flash") => ({
  threadId: THREAD_ID,
  providerSessionId: ProviderSessionId.make("provider-session-deepseek-claude"),
  modelSelection: { instanceId: INSTANCE, model },
  runtimePolicy,
});

const now = DateTime.nowUnsafe();

const providerSession = () => ({
  id: ProviderSessionId.make("inner-session"),
  driver: CLAUDE_AGENT,
  providerInstanceId: INSTANCE,
  status: "ready" as const,
  cwd: "/tmp",
  model: "deepseek-flash",
  capabilities: AcpProviderCapabilitiesV2,
  createdAt: now,
  updatedAt: now,
  lastError: null,
});

const makeSession = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  ({
    instanceId: INSTANCE,
    driver: CLAUDE_AGENT,
    providerSessionId: ProviderSessionId.make("inner-session"),
    providerSession: providerSession(),
    events: Stream.fromIterable(events),
    ensureThread: () => Effect.die("inner ensureThread"),
    resumeThread: () => Effect.die("inner resumeThread"),
    startTurn: () => Effect.die("inner startTurn"),
    steerTurn: () => Effect.die("inner steerTurn"),
    interruptTurn: () => Effect.die("inner interruptTurn"),
    respondToRuntimeRequest: () => Effect.die("inner respondToRuntimeRequest"),
    readThreadSnapshot: () => Effect.die("inner readThreadSnapshot"),
    rollbackThread: () => Effect.die("inner rollbackThread"),
    forkThread: () => Effect.die("inner forkThread"),
  }) satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;

const messageEvent = (): ProviderAdapter.ProviderAdapterV2Event =>
  ({
    type: "message.updated",
    driver: CLAUDE_AGENT,
    message: {
      id: MessageId.make("message-1"),
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      role: "assistant",
      text: "Hi",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: "agent",
      creationSource: "live",
    },
  }) as unknown as ProviderAdapter.ProviderAdapterV2Event;

const toolEvent = (): ProviderAdapter.ProviderAdapterV2Event =>
  ({
    type: "turn_item.updated",
    driver: CLAUDE_AGENT,
    turnItem: {
      type: "command_execution",
      id: TurnItemId.make("turn-item-1"),
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: PROVIDER_THREAD_ID,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      input: "ls",
      output: "README.md",
      exitCode: 0,
    },
  }) as unknown as ProviderAdapter.ProviderAdapterV2Event;

const terminalEvent = (status: "completed" | "failed"): ProviderAdapter.ProviderAdapterV2Event =>
  ({
    type: "turn.terminal",
    driver: CLAUDE_AGENT,
    providerThreadId: PROVIDER_THREAD_ID,
    providerTurnId: "provider-turn-1",
    runOrdinal: 1,
    status,
    failure:
      status === "failed"
        ? {
            class: "usage_limit",
            message: "Claude usage limit reached. Your limit will reset at 3pm.",
            code: null,
            retryable: true,
          }
        : null,
    threadDisposition: "reusable",
  }) as unknown as ProviderAdapter.ProviderAdapterV2Event;

const providerThreadEvent = (): ProviderAdapter.ProviderAdapterV2Event =>
  ({
    type: "provider_thread.updated",
    driver: CLAUDE_AGENT,
    providerThread: {
      id: PROVIDER_THREAD_ID,
      driver: CLAUDE_AGENT,
      providerInstanceId: INSTANCE,
      providerSessionId: null,
      appThreadId: THREAD_ID,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  }) as unknown as ProviderAdapter.ProviderAdapterV2Event;

interface HarnessOptions {
  readonly events?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
  readonly openSessionError?: ProviderAdapter.ProviderAdapterV2Error;
}

const makeHarness = Effect.fn("makeDeepSeekClaudeHarness")(function* (
  options: HarnessOptions = {},
) {
  const createInputs: Array<DeepSeekClaudeAdapterFactoryInput> = [];
  const perspective = {
    events: options.events ?? [],
    ...(options.openSessionError === undefined
      ? {}
      : { openSessionError: options.openSessionError }),
  };
  const inner = ProviderAdapter.ProviderAdapterV2.of({
    instanceId: INSTANCE,
    driver: CLAUDE_AGENT,
    getCapabilities: () => Effect.succeed(AcpProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: () =>
      perspective.openSessionError === undefined
        ? Effect.succeed(makeSession(perspective.events))
        : Effect.fail(perspective.openSessionError),
  });
  const adapter = yield* makeDeepSeekClaudeAdapter({
    instanceId: INSTANCE,
    settings,
    environment: {
      ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key",
      CLAUDE_CONFIG_DIR: "/tmp/deepseek-claude-home",
    },
    providerCatalog: Effect.undefined,
    createClaudeAdapter: (input) => {
      createInputs.push(input);
      return Effect.succeed(inner);
    },
  });
  return { adapter, createInputs };
});

describe("DeepSeekClaudeAdapter", () => {
  it.effect("stamps driver deepseek on every event and never claudeAgent", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness({
        events: [providerThreadEvent(), messageEvent(), toolEvent(), terminalEvent("completed")],
      });
      const session = yield* adapter.openSession(openInput());
      const events = Array.from(yield* Stream.runCollect(session.events));

      expect(events.map((event) => event.type)).toEqual([
        "provider_thread.updated",
        "message.updated",
        "turn_item.updated",
        "turn.terminal",
      ]);
      expect(events.map((event) => event.driver)).toEqual([DEEPSEEK, DEEPSEEK, DEEPSEEK, DEEPSEEK]);
      const providerThread = events[0];
      expect(
        providerThread?.type === "provider_thread.updated"
          ? providerThread.providerThread.driver
          : undefined,
      ).toBe(DEEPSEEK);
      expect(JSON.stringify(events)).not.toContain("claudeAgent");
      expect(session.driver).toBe(DEEPSEEK);
      expect(session.providerSession.driver).toBe(DEEPSEEK);
    }),
  );

  it.effect("rejects Pro and Claude model ids, accepts the documented Flash alias", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness();
      for (const model of ["deepseek-v4-pro", "claude-opus-4-5"]) {
        const result = yield* adapter.openSession(openInput(model)).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") continue;
        expect(result.failure.message).toContain("DeepSeek V4.1 Flash");
      }
      const session = yield* adapter.openSession(openInput("deepseek-v4-flash"));
      expect(session.driver).toBe(DEEPSEEK);
    }),
  );

  it.effect("words a Claude usage-limit failure for DeepSeek", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness({ events: [terminalEvent("failed")] });
      const session = yield* adapter.openSession(openInput());
      const [terminal] = Array.from(yield* Stream.runCollect(session.events));
      expect(terminal?.type).toBe("turn.terminal");
      if (terminal?.type !== "turn.terminal") return;
      expect(terminal.status).toBe("failed");
      expect(terminal.failure?.message).toContain("DeepSeek rate limit reached");
      expect(terminal.failure?.message).not.toContain("Claude usage limit");
    }),
  );

  it.effect("hands the Claude adapter DeepSeek's 786432 auto-compact window", () =>
    Effect.gen(function* () {
      const { createInputs } = yield* makeHarness();
      expect(createInputs).toHaveLength(1);
      expect(createInputs[0]?.create.config.autoCompactWindow).toBe("786432");
      expect(createInputs[0]?.create.config.customModels).toEqual([]);
      expect(createInputs[0]?.create.config.launchArgs).toBe("");
      expect(createInputs[0]?.create.config.idleCompaction).toBe("default");
      expect(deepSeekClaudeSettings(settings).autoCompactWindow).toBe("786432");
    }),
  );

  it.effect("hands the factory the DeepSeek endpoint, key and fixed home", () =>
    Effect.gen(function* () {
      const { createInputs } = yield* makeHarness();
      const input = createInputs[0];
      expect(input?.create.instanceId).toBe(INSTANCE);
      expect(input?.processEnvironment.ANTHROPIC_AUTH_TOKEN).toBe("fake-deepseek-key");
      expect(input?.processEnvironment.CLAUDE_CONFIG_DIR).toBe("/tmp/deepseek-claude-home");
      expect(
        input?.create.environment.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")?.value,
      ).toBe("fake-deepseek-key");
      expect(input?.providerCatalog).toBeDefined();
    }),
  );

  it.effect("keeps Flash pinned on a turn and an ensured thread", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness();
      const session = yield* adapter.openSession(openInput());
      const turn = yield* session
        .startTurn({ modelSelection: { instanceId: INSTANCE, model: "deepseek-v4-pro" } } as never)
        .pipe(Effect.result);
      expect(turn._tag).toBe("Failure");
      if (turn._tag === "Failure") {
        expect(turn.failure.message).toContain("DeepSeek V4.1 Flash");
      }
      const ensured = yield* session
        .ensureThread({
          modelSelection: { instanceId: INSTANCE, model: "claude-opus-4-5" },
        } as never)
        .pipe(Effect.result);
      expect(ensured._tag).toBe("Failure");
      if (ensured._tag === "Failure") {
        expect(ensured.failure.message).toContain("DeepSeek V4.1 Flash");
      }
    }),
  );

  it.effect("words Claude auth failures for DeepSeek, never Claude login", () =>
    Effect.gen(function* () {
      const authFailure = {
        ...terminalEvent("failed"),
        failure: {
          class: "provider_error",
          message: "Run claude auth login to continue.",
          code: null,
          retryable: false,
        },
      } as unknown as ProviderAdapter.ProviderAdapterV2Event;
      const { adapter } = yield* makeHarness({ events: [authFailure] });
      const session = yield* adapter.openSession(openInput());
      const [terminal] = Array.from(yield* Stream.runCollect(session.events));
      if (terminal?.type !== "turn.terminal") throw new Error("expected a turn terminal");
      expect(terminal.failure?.message).toContain("API key saved in this DeepSeek");
      expect(terminal.failure?.message).not.toContain("claude auth login");
    }),
  );

  it.effect("rewrites an inner adapter error to deepseek", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makeHarness({
        openSessionError: new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_AGENT,
          detail: "inner Claude failure",
        }),
      });
      const result = yield* adapter.openSession(openInput()).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure.driver).toBe(DEEPSEEK);
      expect(result.failure.message).toContain("inner Claude failure");
    }),
  );

  it.effect("translates every Claude-specific failure wording, and nothing else", () =>
    Effect.sync(() => {
      expect(
        deepSeekFailureText("Claude usage limit reached. Your limit will reset at 3pm."),
      ).toContain("DeepSeek rate limit reached");
      expect(deepSeekFailureText("claude auth login")).toContain("API key saved in this DeepSeek");
      expect(deepSeekFailureText("Claude turn failed. Try again.")).toBe(
        "DeepSeek turn failed. Try again.",
      );
      expect(deepSeekFailureText("Tool exited with code 1.")).toBe("Tool exited with code 1.");
    }),
  );
});
