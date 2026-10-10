// DeepSeek adapter boundary tests: Flash-only gating, `deepseek` identity on
// sessions/events/errors, DeepSeek-worded failures, and the shared runtime
// behaviors (streaming, tool roundtrip, cancel, second turn, resume) through
// a fake SDK query — the real adapter/protocol boundary, not a mock wrapper.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DeepSeekSettings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { DeepSeekModelCatalog } from "../DeepSeekModelCatalog.ts";
import { makeDeepSeekAdapter } from "./DeepSeekAdapter.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);
const DEEPSEEK = ProviderDriverKind.make("deepseek");
const INSTANCE = ProviderInstanceId.make("deepseek");

const SYNTHETIC_DEEPSEEK_CATALOG: DeepSeekModelCatalog = {
  models: [
    {
      model: {
        slug: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        aliases: ["deepseek-v4-flash", "vision-exp"],
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
                { id: "max", label: "Max" },
              ],
            },
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select",
              options: [{ id: "1m", label: "1M", isDefault: true }],
            },
          ],
        },
      },
      runtime: {
        modelSuffixes: { contextWindow: { "1m": "[1m]" } },
        contextWindowTokens: { "1m": 1_000_000 },
      },
      compatibility: {},
    },
  ],
};

class FakeDeepSeekQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly setModelCalls: Array<string | undefined> = [];
  public closeCalls = 0;
  public interrupt?: () => Promise<unknown>;

  emit(message: SDKMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<SDKMessage>> => {
        const value = this.queue.shift();
        if (value) {
          return Promise.resolve({ done: false, value });
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }

  async setModel(model?: string): Promise<void> {
    this.setModelCalls.push(model);
  }

  async setPermissionMode(): Promise<void> {}
  async setMaxThinkingTokens(): Promise<void> {}
  close(): void {
    this.closeCalls += 1;
  }
}

class DeepSeekAdapterTag extends Context.Service<
  DeepSeekAdapterTag,
  ProviderAdapterShape<ProviderAdapterError>
>()("t3/provider/Layers/DeepSeekAdapter.test/DeepSeekAdapterTag") {}

function makeHarness(input?: {
  readonly threadId?: ThreadId;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const query = new FakeDeepSeekQuery();
  let createInput:
    | { readonly prompt: AsyncIterable<unknown>; readonly options: Record<string, unknown> }
    | undefined;
  const layer = Layer.effect(
    DeepSeekAdapterTag,
    makeDeepSeekAdapter(decodeDeepSeekSettings({}), {
      instanceId: INSTANCE,
      environment: {
        ANTHROPIC_AUTH_TOKEN: "fake-deepseek-key",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        CLAUDE_CONFIG_DIR: "/tmp/deepseek-test-home",
        PATH: "/usr/bin",
        ...(input?.environment ?? {}),
      },
      modelCatalog: Effect.succeed(SYNTHETIC_DEEPSEEK_CATALOG),
      createQuery: (queryInput) => {
        createInput = queryInput as typeof createInput;
        return query as never;
      },
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/deepseek-adapter-test", "/tmp")),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, query, getCreateInput: () => createInput };
}

function makeDeterministicRandomService(seed = 0x1234_5678) {
  let state = seed >>> 0;
  const nextIntUnsafe = () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };
  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

const THREAD_ID = ThreadId.make("thread-deepseek-1");

const flashSelection = (model = "deepseek-flash"): ModelSelection =>
  ({ instanceId: INSTANCE, model }) as unknown as ModelSelection;

const successResult = (uuid: string) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    session_id: "sdk-session-deepseek",
    uuid,
  }) as unknown as SDKMessage;

describe("DeepSeekAdapter", () => {
  it.effect("rejects a non-deepseek provider key", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: DEEPSEEK,
          operation: "startSession",
          issue: "Expected provider 'deepseek' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects Pro and Claude model ids, accepts the documented Flash alias", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      for (const model of ["deepseek-v4-pro", "claude-sonnet-5", "claude-opus-5-5"]) {
        const result = yield* adapter
          .startSession({
            threadId: ThreadId.make(`thread-deepseek-reject-${model.length}`),
            provider: DEEPSEEK,
            runtimeMode: "full-access",
            modelSelection: flashSelection(model),
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure", model);
        if (result._tag !== "Failure") continue;
        assert.equal(result.failure._tag, "ProviderAdapterValidationError");
        if (result.failure._tag === "ProviderAdapterValidationError") {
          assert.equal(result.failure.provider, "deepseek");
          assert.match(result.failure.issue, /DeepSeek V4\.1 Flash/);
        }
      }
      const session = yield* adapter.startSession({
        threadId: ThreadId.make("thread-deepseek-alias-ok"),
        provider: DEEPSEEK,
        runtimeMode: "full-access",
        modelSelection: flashSelection("deepseek-v4-flash"),
      });
      assert.equal(session.provider, "deepseek");
      assert.equal(session.model, "deepseek-flash");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts a Flash session stamped deepseek with endpoint, key, and persona", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      const threadId = ThreadId.make("thread-deepseek-persona");
      const session = yield* adapter.startSession({
        threadId,
        provider: DEEPSEEK,
        runtimeMode: "full-access",
        personalBot: true,
        personalBotId: "test-bot",
        systemInstructions: "You are TestBot. Answer briefly.",
        modelSelection: flashSelection(),
      });
      assert.equal(session.provider, "deepseek");
      assert.equal(session.providerInstanceId, "deepseek");
      assert.equal(session.model, "deepseek-flash");
      assert.isDefined(session.resumeCursor);

      const options = harness.getCreateInput()?.options as
        | {
            model?: string;
            env?: NodeJS.ProcessEnv;
            systemPrompt?: { append?: string };
            settingSources?: ReadonlyArray<string>;
          }
        | undefined;
      // Pinned main-model mapping: regular bot turns never route to Pro.
      assert.equal(options?.model, "deepseek-flash[1m]");
      // Fixed endpoint + the instance key reach the SDK subprocess…
      assert.equal(options?.env?.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
      assert.equal(options?.env?.ANTHROPIC_AUTH_TOKEN, "fake-deepseek-key");
      // …while unrelated provider tokens do not.
      assert.equal(options?.env?.PB_SECRET_SOMETHING, undefined);
      // Persona rides the session prompt; bot isolation stays on.
      assert.match(options?.systemPrompt?.append ?? "", /TestBot/);
      assert.deepEqual(options?.settingSources, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("streams text plus a tool roundtrip to turn.completed, all stamped deepseek", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: DEEPSEEK,
        runtimeMode: "full-access",
        modelSelection: flashSelection(),
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-deepseek",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-deepseek",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-deepseek",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: { type: "content_block_stop", index: 0 },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-deepseek",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-deepseek",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: { type: "content_block_stop", index: 1 },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-deepseek",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: { id: "assistant-message-1", content: [{ type: "text", text: "Hi" }] },
      } as unknown as SDKMessage);
      harness.query.emit(successResult("result-1"));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );
      for (const event of events) {
        assert.equal(event.provider, "deepseek", event.type);
      }
      const delta = events.find((event) => event.type === "content.delta");
      assert.equal(delta?.type, "content.delta");
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "Hi");
        assert.equal(String(delta.turnId), String(turn.turnId));
      }
      const tool = events.find((event) => event.type === "item.started");
      assert.equal(tool?.type, "item.started");
      if (tool?.type === "item.started") {
        assert.equal(tool.payload.itemType, "command_execution");
      }
      const completed = events[events.length - 1];
      assert.equal(completed?.type, "turn.completed");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the Flash model pinned across a second turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      const session = yield* adapter.startSession({
        threadId: ThreadId.make("thread-deepseek-second"),
        provider: DEEPSEEK,
        runtimeMode: "full-access",
        modelSelection: flashSelection(),
      });
      const first = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first",
        attachments: [],
        modelSelection: flashSelection(),
      });
      const firstDone = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      harness.query.emit(successResult("result-first"));
      yield* Fiber.join(firstDone);

      const second = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "second",
        attachments: [],
        modelSelection: flashSelection(),
      });
      const secondDone = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      harness.query.emit(successResult("result-second"));
      yield* Fiber.join(secondDone);

      assert.notEqual(String(first.turnId), String(second.turnId));
      // Same Flash model: no model switch is issued to the SDK.
      assert.deepEqual(harness.query.setModelCalls, []);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.provider, "deepseek");
      assert.equal(sessions[0]?.model, "deepseek-flash");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("cancels a running turn and closes the session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      const session = yield* adapter.startSession({
        threadId: ThreadId.make("thread-deepseek-cancel"),
        provider: DEEPSEEK,
        runtimeMode: "full-access",
        modelSelection: flashSelection(),
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      harness.query.interrupt = async () => {
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          session_id: "sdk-session-deepseek",
          uuid: "result-interrupted",
        } as unknown as SDKMessage);
      };
      yield* adapter.interruptTurn(session.threadId);
      const [completed] = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.provider, "deepseek");
        assert.equal(completed.payload.state, "interrupted");
      }
      assert.equal(yield* adapter.hasSession(session.threadId), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("words auth failures for DeepSeek, never Claude login", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      const session = yield* adapter.startSession({
        threadId: ThreadId.make("thread-deepseek-auth"),
        provider: DEEPSEEK,
        runtimeMode: "full-access",
        modelSelection: flashSelection(),
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-deepseek",
        uuid: "assistant-auth",
        parent_tool_use_id: null,
        error: "authentication_failed",
        message: { id: "assistant-auth", content: [] },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: true,
        errors: [],
        session_id: "sdk-session-deepseek",
        uuid: "result-auth",
      } as unknown as SDKMessage);
      const [completed] = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.provider, "deepseek");
        assert.equal(completed.payload.state, "failed");
        assert.match(completed.payload.errorMessage ?? "", /ANTHROPIC_AUTH_TOKEN/);
        assert.notMatch(completed.payload.errorMessage ?? "", /claude auth login/);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("words rate-limit failures for DeepSeek", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* DeepSeekAdapterTag;
      const session = yield* adapter.startSession({
        threadId: ThreadId.make("thread-deepseek-ratelimit"),
        provider: DEEPSEEK,
        runtimeMode: "full-access",
        modelSelection: flashSelection(),
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-deepseek",
        uuid: "assistant-rl",
        parent_tool_use_id: null,
        error: "rate_limit",
        message: { id: "assistant-rl", content: [] },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: true,
        errors: [],
        session_id: "sdk-session-deepseek",
        uuid: "result-rl",
      } as unknown as SDKMessage);
      const [completed] = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.match(completed.payload.errorMessage ?? "", /DeepSeek rate limit/);
        assert.notMatch(completed.payload.errorMessage ?? "", /Claude usage limit/);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
