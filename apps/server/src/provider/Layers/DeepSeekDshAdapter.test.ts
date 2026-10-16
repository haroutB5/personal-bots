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
  DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpError from "effect-acp/errors";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { classifyProviderError } from "../../personal/tasks/taskLimitPolicy.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { resetBotProviderProcesses } from "../botProviderProcesses.ts";
import { isMissingProviderConversationText } from "../missingProviderConversation.ts";
import { DSH_PINNED_VERSION, makeDshAcpRuntime } from "../acp/DshAcpSupport.ts";
import {
  makeDeepSeekDshAdapter,
  dshImageTooLargeText,
  translateDshFailure,
} from "./DeepSeekDshAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const instanceId = ProviderInstanceId.make("deepseek-dsh-test");
const threadId = ThreadId.make("dsh-thread");
const nativeSessionId = "mock-session-1";
const decodeStart = Schema.decodeSync(ProviderSessionStartInput);

/** Every WARN with its structured fields, so a test can count and name them. */
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
  /** The error text a prompt fails with, as dsh reports it. */
  readonly promptError?: string;
  /** From this launch on (1 = the first), starting a dsh process fails. */
  readonly launchFailsFrom?: number;
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
  let launches = 0;
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
      ++launches >= (options?.launchFailsFrom ?? Number.POSITIVE_INFINITY)
        ? Effect.fail(AcpError.AcpRequestError.internalError("Mock launch failure"))
        : makeDshAcpRuntime({
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

  it.effect("starts a new reasoning paragraph when a thought follows a tool call", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      const beforeTurn = (yield* harness.seen()).length;
      yield* harness.adapter.sendTurn({
        threadId,
        input: "paragraph-probe",
        modelSelection: { instanceId, model: "deepseek-flash" },
      });
      const events = (yield* harness.seen()).slice(beforeTurn);
      // The real frame order through the real ACP runtime: thought, tool_call,
      // tool_call_update, thought. dsh sends no break of its own between the
      // two thinking steps, so the adapter adds one to the second.
      const deltas = events.filter((event) => event.type === "content.delta");
      expect(deltas.filter((event) => event.payload.streamKind === "reasoning_text").length).toBe(
        2,
      );
      expect(
        deltas
          .filter((event) => event.payload.streamKind === "reasoning_text")
          .map((event) => event.payload.delta),
      ).toEqual(["Let me check the file.", "\n\nThe file is fine."]);
      // The visible reply is untouched.
      expect(
        deltas
          .filter((event) => event.payload.streamKind === "assistant_text")
          .map((event) => event.payload.delta),
      ).toEqual(["Done."]);
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("strips leaked tool-call markup from a reply, and warns about its tool", () => {
    const logs = captureWarnLines();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(
        startInput({ cwd, personalBot: true, personalBotId: "bot-one" }),
      );
      const beforeTurn = (yield* harness.seen()).length;
      yield* harness.adapter.sendTurn({
        threadId,
        input: "dsml-probe",
        modelSelection: { instanceId, model: "deepseek-flash" },
      });
      const events = (yield* harness.seen()).slice(beforeTurn);
      const visible = events
        .filter((event) => event.type === "content.delta")
        .filter((event) => event.payload.streamKind === "assistant_text")
        .map((event) => event.payload.delta)
        .join("");
      // The invoke block (split across two deltas by the mock) and the three
      // stray closing tags are gone; the reply around them is untouched.
      expect(visible).toBe("Before.After.");
      expect(visible).not.toContain("DSML");
      expect(visible).not.toContain("tennis scores");
      const warnings = logs.lines.filter(
        (line) => line.text === "Removed DeepSeek tool-call markup from a bot reply",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        fields: { threadId, botId: "bot-one", tool: "web_search" },
      });
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }).pipe(Effect.provide(logs.layer));
  });

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

  it.effect("waits for the running turn without retrying a held message in a loop", () => {
    // 16 Oct: the drain retried a held message as fast as it could for the
    // whole running turn, ~7,000 attempts a second per chat on the live server.
    let attempts = 0;
    const tracer = Tracer.make({
      span: (options) => {
        if (options.name === "DeepSeekDshAdapter.attemptTurn") attempts += 1;
        return new Tracer.NativeSpan(options);
      },
    });
    return Effect.gen(function* () {
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
      const held = ["First held: say APPLE.", "Second held: say PEAR."];
      for (const input of held) {
        yield* harness.adapter.sendTurn({
          threadId,
          input,
          modelSelection: { instanceId, model: "deepseek-flash" },
        });
      }
      yield* realSleep(300);
      // The owner's attempt, then per held send its own attempt plus one drain
      // attempt that found the turn still running and stopped.
      expect(attempts).toBeLessThanOrEqual(5);
      // The end of the running turn starts the held messages, in order.
      yield* harness.adapter.interruptTurn(threadId);
      yield* Fiber.join(owner).pipe(Effect.ignore);
      yield* harness.waitForPromptCount(3);
      yield* harness.waitForTurnCompletions(3);
      const prompts = harness
        .requests()
        .filter((request) => request.method === "session/prompt")
        .map((request) => JSON.stringify(request.params));
      expect(prompts[1]).toContain("APPLE");
      expect(prompts[2]).toContain("PEAR");
      expect(attempts).toBeLessThanOrEqual(8);
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }).pipe(Effect.withTracer(tracer));
  });

  it.effect("starts a send that arrives as a turn ends behind the messages already held", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      yield* harness.adapter.startSession(startInput({ cwd }));
      const send = (input: string) =>
        harness.adapter.sendTurn({
          threadId,
          input,
          modelSelection: { instanceId, model: "deepseek-flash" },
        });
      const owner = yield* send("Run this exact PowerShell command: Start-Sleep -Seconds 60").pipe(
        Effect.forkScoped,
      );
      yield* harness.waitForPromptCount(1);
      yield* send("Held first: say APPLE.");
      yield* send("Held second: say PEAR.");
      yield* harness.adapter.interruptTurn(threadId);
      yield* Fiber.join(owner).pipe(Effect.ignore);
      // Sent as the turn ends. Whether it lands before the drain that turn
      // scheduled is timing (Astra reproduced C, A, B with a probe); either way
      // it must start behind the held messages.
      yield* send("Fresh: say PLUM.").pipe(Effect.forkScoped);
      yield* harness.waitForPromptCount(4);
      yield* harness.waitForTurnCompletions(4);
      const prompts = harness
        .requests()
        .filter((request) => request.method === "session/prompt")
        .map((request) => JSON.stringify(request.params));
      expect(prompts.slice(1).map((text) => text.match(/APPLE|PEAR|PLUM/)?.[0])).toEqual([
        "APPLE",
        "PEAR",
        "PLUM",
      ]);
      yield* harness.adapter.stopSession(threadId);
      resetBotProviderProcesses();
    }),
  );

  it.effect("fails a held message that cannot start, and still runs the ones behind it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      // The first launch is the session; the bot-edit restart is the second.
      const harness = yield* makeHarness(cwd, { launchFailsFrom: 2 });
      yield* harness.adapter.startSession(startInput({ cwd }));
      const owner = yield* harness.adapter
        .sendTurn({
          threadId,
          input: "Run this exact PowerShell command: Start-Sleep -Seconds 60",
          modelSelection: { instanceId, model: "deepseek-flash" },
        })
        .pipe(Effect.forkScoped);
      yield* harness.waitForPromptCount(1);
      // A bot edit rides this held message, so starting it restarts dsh.
      const edited = yield* harness.adapter.sendTurn({
        threadId,
        input: "After the edit: say APPLE.",
        systemInstructions: "You are an edited test bot.",
        modelSelection: { instanceId, model: "deepseek-flash" },
      });
      yield* harness.adapter.sendTurn({
        threadId,
        input: "Behind it: say PEAR.",
        modelSelection: { instanceId, model: "deepseek-flash" },
      });
      yield* harness.adapter.interruptTurn(threadId);
      yield* Fiber.join(owner).pipe(Effect.ignore);
      yield* harness.waitForPromptCount(2);
      const events = yield* harness.waitForTurnCompletions(3);
      const failed = events.find(
        (event) => event.type === "turn.completed" && event.turnId === edited.turnId,
      );
      expect(failed?.payload).toMatchObject({ state: "failed" });
      const prompts = harness
        .requests()
        .filter((request) => request.method === "session/prompt")
        .map((request) => JSON.stringify(request.params));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("PEAR");
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
    expect(
      canonicalBase64.test(Buffer.alloc(DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES).toString("base64")),
    ).toBe(true);
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
        bytes: Buffer.alloc(DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES + 1, 7),
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

  it.effect("refuses an oversized image before any session exists, so nothing overwrites it", () =>
    Effect.gen(function* () {
      // QA 1.66.45, C5F/C5R: the refusal used to be made while the turn started,
      // after `startSession` had already emitted "starting" and "ready", so those
      // two events landed ~1 ms later and left the session ready with no error
      // and the chat with nothing on it. The server now asks this first, before
      // it starts or reuses the session, so no such event is in flight.
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-cwd-" });
      const harness = yield* makeHarness(cwd);
      const bytes = DEEPSEEK_DSH_MAX_INLINE_IMAGE_BYTES + 1;
      const oversized = writeImageAttachment({
        attachmentsDir,
        id: "dsh-preflight-12345678-1234-1234-1234-123456789abc",
        name: "carrier.png",
        bytes: Buffer.alloc(bytes, 3),
      });

      const failure = yield* Effect.flip(
        harness.adapter.validateTurn({
          modelSelection: { instanceId, model: "deepseek-flash" },
          input: "How much is this?",
          attachments: [oversized],
        }),
      );
      expect(failure).toMatchObject({
        _tag: "ProviderAdapterRequestError",
        detail: dshImageTooLargeText({ name: "carrier.png", bytes }),
      });
      // Nothing was started: there is no session whose start events could land
      // after this refusal, which is the whole point of asking first.
      expect(yield* harness.adapter.listSessions()).toEqual([]);

      const small = writeImageAttachment({
        attachmentsDir,
        id: "dsh-preflight-small-12345678-1234-1234-1234-123456789abc",
        name: "small.png",
        bytes: Uint8Array.from([1, 2, 3, 4]),
      });
      yield* harness.adapter.validateTurn({
        modelSelection: { instanceId, model: "deepseek-flash" },
        input: "How much is this?",
        attachments: [small],
      });
      expect(yield* harness.adapter.listSessions()).toEqual([]);
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

  it.effect("warns once for the skill a bot's plugin folder cannot load", () => {
    const logs = captureWarnLines();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const botId = "bot-one";
      const pluginDir = path.join(config.baseDir, "bot-plugins", botId);
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

      const harness = yield* makeHarness(process.cwd());
      yield* harness.adapter.startSession(startInput({ personalBot: true, personalBotId: botId }));

      const warnings = logs.lines.filter((line) => line.text === "bot plugin skill failed to load");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        fields: {
          botId,
          path: path.join(skillDir, "SKILL.md"),
          reason: expect.stringContaining("UTF-8 BOM"),
        },
      });
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
});
