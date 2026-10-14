// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off
/**
 * The dsh adapter against the REAL ACP runtime, driving `acp-mock-agent.ts`
 * in its `T3_ACP_DSH_PROFILE` mode.
 *
 * The mock replays the exact frames recorded from dsh 0.2.0-rc.2
 * (`design/hbots/dsh-harness/probe/out/events-run1.jsonl`), including the
 * behaviours the adapter is written around: no `session/load`, one prompt in
 * flight per session, and a cancelled turn that settles with `cancelled`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEEPSEEK_AGENT_MODE_OPTION_ID,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { classifyProviderError } from "../../personal/tasks/taskLimitPolicy.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { resetBotProviderProcesses } from "../botProviderProcesses.ts";
import { isMissingProviderConversationText } from "../missingProviderConversation.ts";
import { DSH_PINNED_VERSION, makeDshAcpRuntime } from "../acp/DshAcpSupport.ts";
import {
  DSH_MAX_INLINE_IMAGE_BYTES,
  makeDeepSeekDshAdapter,
  translateDshFailure,
} from "./DeepSeekDshAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const instanceId = ProviderInstanceId.make("deepseek-dsh-test");
const threadId = ThreadId.make("dsh-thread");
const nativeSessionId = "mock-session-1";
const decodeStart = Schema.decodeSync(ProviderSessionStartInput);

interface HarnessOptions {
  /** The error text a prompt fails with, as dsh reports it. */
  readonly promptError?: string;
}

/** One recorded request the mock agent received. */
interface LoggedRequest {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const makeHarness = Effect.fn("makeDshHarness")(function* (cwd: string, options?: HarnessOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-home-" });
  const requestLog = path.join(dshHome, "requests.ndjson");
  const seen = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
  const adapter = yield* makeDeepSeekDshAdapter({
    instanceId,
    runtime: {
      runtimeDir: dshHome,
      binJs: path.join(dshHome, "unused-bin.js"),
      version: DSH_PINNED_VERSION,
    },
    dshHome,
    environment: {},
    childProcessSpawner: spawner,
    makeRuntime: (input) =>
      makeDshAcpRuntime({
        ...input,
        childProcessSpawner: spawner,
        spawn: {
          command: process.execPath,
          args: [mockAgentPath],
          cwd: input.cwd,
          env: {
            ...process.env,
            ...input.spawn.env,
            T3_ACP_DSH_PROFILE: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLog,
            ...(options?.promptError === undefined
              ? {}
              : { T3_ACP_DSH_PROMPT_ERROR: options.promptError }),
          },
          extendEnv: false,
        },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
  });
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) => Ref.update(seen, (current) => [...current, event])),
    Effect.forkScoped({ startImmediately: true }),
  );

  const requests = (): ReadonlyArray<LoggedRequest> => {
    if (!NodeFS.existsSync(requestLog)) return [];
    return NodeFS.readFileSync(requestLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as {
            readonly method?: unknown;
            readonly params?: unknown;
          };
          return typeof parsed.method === "string"
            ? [
                {
                  method: parsed.method,
                  ...(typeof parsed.params === "object" && parsed.params !== null
                    ? { params: parsed.params as Record<string, unknown> }
                    : {}),
                },
              ]
            : [];
        } catch {
          return [];
        }
      });
  };
  const patch = (): Record<string, unknown>[] | undefined => {
    const file = path.join(dshHome, "launch", `${threadId}.json`);
    if (!NodeFS.existsSync(file)) return undefined;
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>[];
  };
  const eventTypes = Effect.map(Ref.get(seen), (events) => events.map((event) => event.type));
  const waitForTurnCompleted = Effect.gen(function* () {
    while (true) {
      const events = yield* Ref.get(seen);
      const completed = events.find((event) => event.type === "turn.completed");
      if (completed !== undefined) return completed;
      yield* realSleep(10);
    }
  });
  const waitForEvents = (count: number) =>
    Effect.gen(function* () {
      while ((yield* Ref.get(seen)).length < count) yield* realSleep(10);
      return yield* Ref.get(seen);
    });
  /**
   * Waits for `count` settled turns before reading the event list. Reading it
   * as soon as the second prompt went out loses the race on a loaded machine:
   * the mock logs the request before its answer settles the turn. The bound is
   * counted in real sleeps, not the test clock, like every other wait here.
   */
  const waitForTurnCompletions = (count: number) =>
    Effect.gen(function* () {
      const completed = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
        events.filter((event) => event.type === "turn.completed").length;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (completed(yield* Ref.get(seen)) >= count) break;
        yield* realSleep(10);
      }
      return yield* Ref.get(seen);
    });
  const waitForPromptCount = (count: number) =>
    Effect.gen(function* () {
      while (requests().filter((request) => request.method === "session/prompt").length < count) {
        yield* realSleep(10);
      }
    });
  return {
    adapter,
    dshHome,
    requests,
    patch,
    eventTypes,
    seen: () => Ref.get(seen),
    waitForTurnCompleted,
    waitForTurnCompletions,
    waitForEvents,
    waitForPromptCount,
  };
});

/**
 * A real wait, not `Effect.sleep`: these tests poll files the mock agent
 * writes, which happens on the wall clock, while `it.effect` runs a test clock.
 */
const realSleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const startInput = (overrides: Partial<ProviderSessionStartInput> = {}) =>
  decodeStart({
    threadId,
    providerInstanceId: instanceId,
    cwd: process.cwd(),
    runtimeMode: "full-access",
    ...overrides,
  });

/** Writes one image into the test data root's attachments folder and returns its metadata. */
const writeImageAttachment = (input: {
  readonly attachmentsDir: string;
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}) => {
  const attachment = {
    type: "image" as const,
    id: input.id,
    name: input.name,
    mimeType: "image/png",
    sizeBytes: input.bytes.byteLength,
  };
  const filePath = NodePath.join(input.attachmentsDir, attachmentRelativePath(attachment)!);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, input.bytes);
  return attachment;
};

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-dsh-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("DeepSeekDshAdapter", (it) => {
  it.effect(
    "starts a dsh session with the recorded handshake, the t3-code MCP entry and reasoning effort",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
        McpProviderSession.setMcpProviderSession({
          environmentId: "test" as never,
          threadId,
          providerSessionId: nativeSessionId,
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:1/mcp",
          authorizationHeader: "Bearer test-token",
          capabilities: new Set(["preview"]),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        const harness = yield* makeHarness(cwd);
        const session = yield* harness.adapter.startSession(startInput({ cwd }));
        expect(session.provider).toBe("deepseek");
        expect(session.resumeCursor).toEqual({
          schemaVersion: 1,
          engine: "dsh",
          resume: nativeSessionId,
          mode: "standard",
        });
        const methods = harness.requests().map((request) => request.method);
        // Never `session/load`: dsh does not implement it.
        expect(methods).not.toContain("session/load");
        expect(methods.slice(0, 2)).toEqual(["initialize", "authenticate"]);
        const newSession = harness.requests().find((request) => request.method === "session/new");
        expect(newSession?.params?.cwd).toBe(cwd);
        expect(newSession?.params?.mcpServers).toEqual([
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
          value: "high",
        });
        yield* harness.adapter.stopSession(threadId);
        resetBotProviderProcesses();
      }),
  );

  it.effect("runs the recorded turn order and flushes the usage ledger", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      const beforeTurn = (yield* harness.seen()).length;
      yield* harness.adapter.sendTurn({
        threadId,
        input: "do the three steps",
        modelSelection: {
          instanceId,
          model: "deepseek-flash",
          options: [{ id: DEEPSEEK_AGENT_MODE_OPTION_ID, value: "standard" }],
        },
      });
      const events = (yield* harness.seen()).slice(beforeTurn);
      const types = events.map((event) => event.type);
      expect(types[0]).toBe("turn.started");
      expect(types.at(-1)).toBe("turn.completed");
      // One `usage_update` per committed step, three steps in the recording.
      const usage = events.filter((event) => event.type === "thread.token-usage.updated");
      expect(usage.length).toBe(3);
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.payload).toMatchObject({ state: "completed", stopReason: "end_turn" });
      const text = JSON.stringify(events);
      // The MCP call and the skill both arrive as tool cards, and the final
      // assistant text is one whole block (no token streaming).
      expect(text).toContain("mcp__t3-code__save_memory");
      expect(text).toContain("skill");
      expect(text).toContain("ECHO:HELLO DSH");
      expect(text).toContain("FALCON-42");
      // The ledger holds one Claude-shaped line per committed step.
      const ledgerFile = NodePath.join(harness.dshHome, "usage", `${nativeSessionId}.jsonl`);
      expect(NodeFS.existsSync(ledgerFile)).toBe(true);
      const lines = NodeFS.readFileSync(ledgerFile, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.type).toBe("assistant");
        expect(line.sessionId).toBe(nativeSessionId);
        expect(typeof line.requestId).toBe("string");
        const message = line.message as Record<string, unknown>;
        expect(typeof message.id).toBe("string");
        expect((message.usage as Record<string, unknown>).input_tokens).toBeTypeOf("number");
      }
      // Content-free: no prompt text, tool output or file contents.
      const rawLedger = NodeFS.readFileSync(ledgerFile, "utf8");
      expect(rawLedger).not.toContain("ECHO:HELLO DSH");
      expect(rawLedger).not.toContain("do the three steps");
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("holds a steer until the running turn ends, and never cancels that turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      // The owning send blocks for its whole turn, exactly as the server calls
      // it (the reactor forks it), so it runs on its own fiber here too.
      const owner = yield* harness.adapter
        .sendTurn({
          threadId,
          input: "Run this exact PowerShell command: Start-Sleep -Seconds 60",
          followUp: "steer",
          modelSelection: { instanceId, model: "deepseek-flash" },
        })
        .pipe(Effect.forkScoped);
      yield* harness.waitForPromptCount(1);
      const steered = yield* harness.adapter
        .sendTurn({
          threadId,
          input: "Steer: also say the word KIWI.",
          followUp: "steer",
          modelSelection: { instanceId, model: "deepseek-flash" },
        })
        .pipe(Effect.forkScoped);
      const first = yield* Fiber.join(steered);
      // A steer arriving mid-turn is held: still one prompt sent, and the
      // running turn was never cancelled, so its tool keeps running.
      expect(harness.requests().filter((r) => r.method === "session/prompt").length).toBe(1);
      expect(harness.requests().map((r) => r.method)).not.toContain("session/cancel");
      expect(first.turnId).toBeDefined();
      // Stop cancels the running turn; the held message then runs as its own.
      yield* harness.adapter.interruptTurn(threadId);
      yield* Fiber.join(owner).pipe(Effect.ignore);
      yield* harness.waitForPromptCount(2);
      yield* harness.waitForTurnCompletions(2);
      const types = yield* harness.eventTypes;
      expect(types.filter((type) => type === "turn.started").length).toBe(2);
      expect(types.filter((type) => type === "turn.completed").length).toBe(2);
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("settles a cancelled turn with the aborted tool, never a second prompt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      const owner = yield* harness.adapter
        .sendTurn({
          threadId,
          input: "Run this exact PowerShell command: Start-Sleep -Seconds 60",
          modelSelection: { instanceId, model: "deepseek-flash" },
        })
        .pipe(Effect.forkScoped);
      yield* harness.waitForPromptCount(1);
      yield* harness.adapter.interruptTurn(threadId);
      yield* Fiber.join(owner).pipe(Effect.ignore);
      const turn = yield* harness.waitForTurnCompleted;
      expect(turn.payload).toMatchObject({ state: "cancelled", stopReason: "cancelled" });
      const text = JSON.stringify(yield* harness.seen());
      expect(text).toContain("Error: tool call aborted");
      expect(harness.requests().map((request) => request.method)).toContain("session/cancel");
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("resumes with the cursor's pinned mode even when the turn asks for another", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(
        startInput({
          cwd,
          resumeCursor: {
            schemaVersion: 1,
            engine: "dsh",
            resume: nativeSessionId,
            mode: "standard",
          },
          modelSelection: {
            instanceId,
            model: "deepseek-flash",
            options: [{ id: DEEPSEEK_AGENT_MODE_OPTION_ID, value: "code" }],
          },
        }),
      );
      const resume = harness.requests().find((request) => request.method === "session/resume");
      expect(resume?.params?.sessionId).toBe(nativeSessionId);
      expect(harness.requests().map((request) => request.method)).not.toContain("session/new");
      const patch = harness.patch();
      expect(patch).toBeDefined();
      const rowIds = (patch ?? []).map((row) => row.id);
      // Standard mode adds no mode rows, whatever the turn asked for.
      expect(rowIds).not.toContain("tools");
      expect(rowIds).toContain("session-log-deepseek");
      expect(NodeFS.existsSync(path.join(harness.dshHome, "launch", `${threadId}.json`))).toBe(
        true,
      );
      yield* harness.adapter.stopSession(threadId);
      // The patch is deleted once the session stops.
      expect(NodeFS.existsSync(path.join(harness.dshHome, "launch", `${threadId}.json`))).toBe(
        false,
      );
      resetBotProviderProcesses();
    }),
  );

  it.effect("fails the first turn on a cursor from another engine, so the server renews it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      const claudeSessionId = "b1ef3808-58f4-40ec-81ed-a9a6af7a8f65";
      const session = yield* harness.adapter.startSession(
        startInput({ cwd, resumeCursor: { resume: claudeSessionId } }),
      );
      // Nothing is started for a cursor dsh cannot resume.
      expect(harness.requests()).toEqual([]);
      expect(session.resumeCursor).toBeUndefined();
      const failure = yield* Effect.exit(
        harness.adapter.sendTurn({
          threadId,
          input: "hello",
          modelSelection: { instanceId, model: "deepseek-flash" },
        }),
      );
      expect(failure._tag).toBe("Failure");
      const message = JSON.stringify(failure);
      expect(isMissingProviderConversationText(message)).toBe(true);
      expect(message).toContain(claudeSessionId);
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("turns a dsh failure into the wording the limit handling reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd, {
        promptError: "Internal error: turn failed: Insufficient Balance",
      });
      yield* harness.adapter.startSession(startInput({ cwd }));
      yield* harness.adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection: { instanceId, model: "deepseek-flash" },
      });
      const turn = yield* harness.waitForTurnCompleted;
      expect(turn.payload).toMatchObject({ state: "failed" });
      const errorMessage = (turn.payload as { errorMessage?: string }).errorMessage ?? "";
      expect(errorMessage).toContain("rate limit");
      expect(classifyProviderError(errorMessage)).toBe("rate_limited");
      expect((turn.payload as { retry?: unknown }).retry).toMatchObject({
        kind: "rate_limited",
      });
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("registers the harness process for the Performance tab", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      const { listBotProviderProcesses } = yield* Effect.promise(
        () => import("../botProviderProcesses.ts"),
      );
      const recorded = listBotProviderProcesses().find((entry) => entry.threadId === threadId);
      expect(recorded?.provider).toBe("deepseek");
      expect(recorded?.pid).toBeGreaterThan(4);
      yield* harness.adapter.stopSession(threadId);
      expect(
        listBotProviderProcesses().find((entry) => entry.threadId === threadId),
      ).toBeUndefined();
      resetBotProviderProcesses();
    }),
  );

  it("the harness's own image validator overflows on the payload of the live photo", () => {
    // The exact check `@deepseek-ai/dsh-acp` 0.2.0-rc.2 runs in `decodeImage`
    // before it accepts an inline image. V8's regexp engine carries its own
    // stack and walks this pattern four characters at a time, so a payload
    // past ~4.47 M characters throws "RangeError: Maximum call stack size
    // exceeded" (measured on Node 24.18.1: 4,472,820 characters pass,
    // 4,472,824 throw). dsh reports that as "Internal error: prompt was not
    // queued: Maximum call stack size exceeded" and the turn dies before the
    // model is asked. The photo that failed on 14 Oct was 8,449,624 bytes.
    const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    expect(() => canonicalBase64.test(Buffer.alloc(8_449_624).toString("base64"))).toThrow(
      RangeError,
    );
    // The limit this adapter holds an inline image to passes the same check.
    expect(canonicalBase64.test(Buffer.alloc(DSH_MAX_INLINE_IMAGE_BYTES).toString("base64"))).toBe(
      true,
    );
  });

  it.effect("refuses an image the harness cannot validate, instead of a stack-overflow turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      const attachment = writeImageAttachment({
        attachmentsDir,
        id: "dsh-oversized-12345678-1234-1234-1234-123456789abc",
        name: "seiko.png",
        bytes: Buffer.alloc(DSH_MAX_INLINE_IMAGE_BYTES + 1, 7),
      });

      const failure = yield* Effect.flip(
        harness.adapter.sendTurn({
          threadId,
          input: "How much is this?",
          attachments: [attachment],
          modelSelection: { instanceId, model: "deepseek-flash" },
        }),
      );
      expect(failure).toMatchObject({
        _tag: "ProviderAdapterRequestError",
        detail:
          'DeepSeek can\'t read this image "seiko.png" (2.0 MB): the DeepSeek engine takes ' +
          "images up to 2.0 MB. Send a smaller photo, or send it to a Claude bot.",
      });
      expect(JSON.stringify(failure)).not.toContain("Maximum call stack");
      // The runtime never sees the payload it would have overflowed on.
      expect(harness.requests().filter((request) => request.method === "session/prompt")).toEqual(
        [],
      );
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("sends a small image inline, the way a turn always has", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      const attachment = writeImageAttachment({
        attachmentsDir,
        id: "dsh-small-12345678-1234-1234-1234-123456789abc",
        name: "small.png",
        bytes: Uint8Array.from([1, 2, 3, 4]),
      });

      yield* harness.adapter.sendTurn({
        threadId,
        input: "What's in this image?",
        attachments: [attachment],
        modelSelection: { instanceId, model: "deepseek-flash" },
      });
      yield* harness.waitForPromptCount(1);
      const prompt = harness.requests().find((request) => request.method === "session/prompt");
      const blocks = (prompt?.params as { prompt?: ReadonlyArray<unknown> } | undefined)?.prompt;
      expect(blocks).toContainEqual({
        type: "image",
        data: "AQIDBA==",
        mimeType: "image/png",
      });
      yield* harness.waitForTurnCompleted;
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

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
});
