// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ProviderAdapterValidationError } from "../Errors.ts";
import {
  makeNativeAcpAdapter,
  selectAutoApprovedPermissionOption,
  isAcpPromptBusyCause,
  isAcpPromptBusyError,
} from "./NativeAcpAdapter.ts";

const BUSY_PROMPT_TEXT = "Internal error: Session already has an active ACP prompt: ses_mock";

it("recognises the busy-prompt refusal OpenCode actually sends", () => {
  // Verbatim shape from the OpenCode 2 ACP agent: the id is appended, and the
  // adapter wraps it as "Internal error: ...".
  expect(
    isAcpPromptBusyError(
      "Internal error: Session already has an active ACP prompt: ses_0f3a9c21e4b7",
    ),
  ).toBe(true);
  // Case and wording changes must not turn a steer into a failed turn.
  expect(isAcpPromptBusyError("session already has an active acp request")).toBe(true);
  expect(isAcpPromptBusyError("Session already has an active ACP")).toBe(true);
  // Everything else still fails at once.
  expect(isAcpPromptBusyError("Insufficient Balance")).toBe(false);
  expect(isAcpPromptBusyError("Maximum call stack size exceeded")).toBe(false);
});

it("recognises the busy refusal in a defect and in a wrapped cause", () => {
  // OpenCode 2 delivers this one as an Effect defect, not a typed failure.
  expect(isAcpPromptBusyCause(Cause.die(new Error(BUSY_PROMPT_TEXT)))).toBe(true);
  expect(
    isAcpPromptBusyCause(
      Cause.die(new Error("ACP request failed", { cause: new Error(BUSY_PROMPT_TEXT) })),
    ),
  ).toBe(true);
  expect(isAcpPromptBusyCause(Cause.fail(new Error("Maximum call stack size exceeded")))).toBe(
    false,
  );
  expect(isAcpPromptBusyCause(Cause.die(new Error("Insufficient Balance")))).toBe(false);
});

it("full access prefers a one-call grant over a remembered permission", () => {
  expect(
    selectAutoApprovedPermissionOption({
      sessionId: "native-test",
      toolCall: { toolCallId: "tool" },
      options: [
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
      ],
    }),
  ).toBe("once");
});

it.live(
  "native ACP keeps OpenCode identity, MCP, persona and the resumable session across process stops",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-" });
      const log = path.join(root, "requests.jsonl");
      const threadId = ThreadId.make("native-acp-test");
      const seen: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-test"),
        displayName: "OpenCode",
        needsFreshContext: (input) =>
          input.freshSession !== true &&
          typeof input.resumeCursor === "object" &&
          input.resumeCursor !== null &&
          "schemaVersion" in input.resumeCursor,
        runtimeOptions: (input) =>
          Effect.succeed({
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd: root,
              env: { ...process.env, T3_ACP_REQUEST_LOG_PATH: log },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
            mcpServers: [
              { type: "http", name: "test-tools", url: "http://127.0.0.1:9/test", headers: [] },
            ],
            ...(input.resumeCursor &&
            typeof input.resumeCursor === "object" &&
            "sessionId" in input.resumeCursor &&
            typeof input.resumeCursor.sessionId === "string"
              ? { resumeSessionId: input.resumeCursor.sessionId, resumeMethod: "resume" as const }
              : {}),
          }),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "approval-required",
      });
      expect(session.resumeCursor).toEqual({ engine: "acp", sessionId: "mock-session-1" });
      yield* adapter.sendTurn({ threadId, input: "first", systemInstructions: "Test persona" });
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "approval-required",
        resumeCursor: session.resumeCursor,
      });
      yield* adapter.sendTurn({ threadId, input: "second" });
      expect(seen.filter((event) => event.type === "turn.completed")).toHaveLength(2);
      expect(seen.every((event) => event.provider === "opencode")).toBe(true);
      const requests = yield* fs.readFileString(log);
      expect(requests).toContain('"method":"session/resume"');
      expect(requests).toContain('"name":"test-tools"');
      expect(requests).toContain("Test persona");
      expect(requests).not.toContain('"method":"authenticate"');
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "old-v1-session" },
      });
      const legacy = yield* adapter
        .sendTurn({ threadId, input: "legacy follow-up" })
        .pipe(Effect.flip);
      expect(legacy.message).toContain("No conversation found with session ID");
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "approval-required",
        freshSession: true,
      });
      yield* adapter.sendTurn({
        threadId,
        input: "legacy follow-up",
        turnContext: "Recovered visible chat history",
      });
      expect(yield* fs.readFileString(log)).toContain("Recovered visible chat history");
      yield* adapter.stopAll();
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "a message sent during a running turn waits for it instead of failing the send",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-queue-" });
      const log = path.join(root, "requests.jsonl");
      const threadId = ThreadId.make("native-acp-queue-test");
      const seen: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-test"),
        displayName: "OpenCode",
        turnNarration: "NARRATE_PROGRESS",
        runtimeOptions: () =>
          Effect.succeed({
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd: root,
              env: {
                ...process.env,
                T3_ACP_REQUEST_LOG_PATH: log,
                T3_ACP_PROMPT_DELAY_MS: "250",
              },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
          }),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const first = yield* adapter
        .sendTurn({ threadId, input: "first message" })
        .pipe(Effect.forkChild);
      const second = yield* adapter
        .sendTurn({ threadId, input: "second message", followUp: "queue" })
        .pipe(Effect.forkChild);
      const [firstTurn, secondTurn] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(firstTurn.turnId).not.toBe(secondTurn.turnId);
      expect(seen.filter((event) => event.type === "turn.started")).toHaveLength(2);
      expect(seen.filter((event) => event.type === "turn.completed")).toHaveLength(2);
      const requests = yield* fs.readFileString(log);
      expect(requests.indexOf("first message")).toBeLessThan(requests.indexOf("second message"));
      expect(requests).toContain("NARRATE_PROGRESS");
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "a prompt the agent still calls active is retried instead of failing the turn",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-busy-" });
      const threadId = ThreadId.make("native-acp-busy-test");
      const seen: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-test"),
        displayName: "OpenCode",
        runtimeOptions: () =>
          Effect.succeed({
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd: root,
              env: { ...process.env, T3_ACP_BUSY_FIRST_PROMPT: "1" },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
          }),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "after a steer" });
      expect(seen.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(
        seen.some(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
      ).toBe(true);
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "a busy refusal that arrives as a defect is retried and its turn still completes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-defect-busy-" });
      const threadId = ThreadId.make("native-acp-defect-busy-test");
      const seen: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-test"),
        displayName: "OpenCode",
        runtimeOptions: () =>
          Effect.succeed({
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd: root,
              env: {
                ...process.env,
                T3_ACP_DEFECT_PROMPT_ERROR: BUSY_PROMPT_TEXT,
                T3_ACP_DEFECT_PROMPT_COUNT: "1",
              },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
          }),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* adapter.sendTurn({ threadId, input: "after a steer" });
      expect(result.turnId).toBeTruthy();
      // The one refusal was waited out, not skipped.
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeGreaterThanOrEqual(200);
      const completed = seen.filter((event) => event.type === "turn.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ payload: { state: "completed" } });
      const sessions = yield* adapter.listSessions();
      expect(sessions[0]).toMatchObject({ status: "ready", activeTurnId: undefined });
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "a non-busy defect fails the turn promptly, settles it, and lets the next turn run",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-defect-" });
      const threadId = ThreadId.make("native-acp-defect-test");
      const seen: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-test"),
        displayName: "OpenCode",
        runtimeOptions: () =>
          Effect.succeed({
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd: root,
              env: {
                ...process.env,
                T3_ACP_DEFECT_PROMPT_ERROR: "Insufficient Balance",
                T3_ACP_DEFECT_PROMPT_COUNT: "1",
              },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
          }),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const startedAt = yield* Clock.currentTimeMillis;
      const refused = yield* adapter.sendTurn({ threadId, input: "refused" }).pipe(Effect.exit);
      expect(Exit.isFailure(refused)).toBe(true);
      // It is not the busy text, so it must not wait the 10 s retry window.
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(5_000);
      const failed = seen.filter(
        (event) => event.type === "turn.completed" && event.payload.state === "failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        payload: { state: "failed", errorMessage: expect.stringContaining("Insufficient Balance") },
      });
      const afterFailure = yield* adapter.listSessions();
      expect(afterFailure[0]).toMatchObject({ status: "ready", activeTurnId: undefined });

      // The failed turn left nothing behind: the next message starts and completes.
      const next = yield* adapter.sendTurn({ threadId, input: "next" });
      expect(next.turnId).toBeTruthy();
      expect(
        seen.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
      ).toHaveLength(1);
      const sessions = yield* adapter.listSessions();
      expect(sessions[0]).toMatchObject({ status: "ready", activeTurnId: undefined });
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "a busy refusal that never clears fails after the bounded wait and leaves no running turn",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-stuck-" });
      const threadId = ThreadId.make("native-acp-stuck-test");
      const seen: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-test"),
        displayName: "OpenCode",
        runtimeOptions: () =>
          Effect.succeed({
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd: root,
              env: {
                ...process.env,
                T3_ACP_DEFECT_PROMPT_ERROR: BUSY_PROMPT_TEXT,
                T3_ACP_DEFECT_PROMPT_COUNT: "999",
              },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
          }),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const startedAt = yield* Clock.currentTimeMillis;
      const refused = yield* adapter.sendTurn({ threadId, input: "still busy" }).pipe(Effect.exit);
      expect(Exit.isFailure(refused)).toBe(true);
      // The whole bounded wait was used before the turn was failed.
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeGreaterThanOrEqual(9_000);
      const failed = seen.filter(
        (event) => event.type === "turn.completed" && event.payload.state === "failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        payload: { state: "failed", errorMessage: expect.stringContaining("active ACP prompt") },
      });
      // The cleanup must not kill the agent session a genuinely running prompt
      // could still own; it only settles this rejected turn.
      const sessions = yield* adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ status: "ready", activeTurnId: undefined });
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  40_000,
);

it.live(
  "a steer whose new prompt is refused as busy keeps its turn and never strands the session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-steer-busy-" });
      const log = path.join(root, "requests.jsonl");
      const threadId = ThreadId.make("native-acp-steer-busy-test");
      const seen: ProviderRuntimeEvent[] = [];
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-test"),
        displayName: "OpenCode",
        runtimeOptions: () =>
          Effect.succeed({
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd: root,
              env: {
                ...process.env,
                T3_ACP_REQUEST_LOG_PATH: log,
                T3_ACP_PROMPT_DELAY_MS: "400",
                T3_ACP_DEFECT_PROMPT_ERROR: BUSY_PROMPT_TEXT,
                T3_ACP_DEFECT_PROMPT_COUNT: "1",
                T3_ACP_DEFECT_PROMPT_START: "2",
              },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
          }),
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const first = yield* adapter
        .sendTurn({ threadId, input: "long first message" })
        .pipe(Effect.forkChild);
      yield* Effect.sleep("80 millis");
      const second = yield* adapter
        .sendTurn({ threadId, input: "steer message" })
        .pipe(Effect.forkChild);
      const [firstTurn, secondTurn] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(firstTurn.turnId).toBe(secondTurn.turnId);
      expect(seen.filter((event) => event.type === "turn.aborted")).toHaveLength(0);
      const completed = seen.filter((event) => event.type === "turn.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ payload: { state: "completed" } });
      const requests = yield* fs.readFileString(log);
      expect(requests.indexOf("long first message")).toBeLessThan(
        requests.indexOf("steer message"),
      );
      const sessions = yield* adapter.listSessions();
      expect(sessions[0]).toMatchObject({ status: "ready", activeTurnId: undefined });
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

for (const failSetup of ["none", "middle", "final", "prompt"] as const) {
  it.live(
    `concurrent steers retain one logical turn, including setup failure=${failSetup}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-native-acp-steer-" });
        const log = path.join(root, "requests.jsonl");
        const threadId = ThreadId.make("native-acp-steer-test");
        const seen: ProviderRuntimeEvent[] = [];
        const adapter = yield* makeNativeAcpAdapter({
          provider: ProviderDriverKind.make("opencode"),
          instanceId: ProviderInstanceId.make("opencode-test"),
          displayName: "OpenCode",
          configureTurn: (_runtime, input) =>
            (failSetup === "middle" && input.input === "steer message") ||
            (failSetup === "final" && input.input === "another steer")
              ? Effect.fail(
                  new ProviderAdapterValidationError({
                    provider: ProviderDriverKind.make("opencode"),
                    operation: "sendTurn",
                    issue: "Setup refused",
                  }),
                )
              : Effect.void,
          runtimeOptions: () =>
            Effect.succeed({
              spawn: {
                command: process.execPath,
                args: [
                  NodeURL.fileURLToPath(
                    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                  ),
                ],
                cwd: root,
                env: {
                  ...process.env,
                  T3_ACP_REQUEST_LOG_PATH: log,
                  T3_ACP_PROMPT_DELAY_MS: "400",
                  ...(failSetup === "prompt" ? { T3_ACP_FAIL_PROMPT: "1" } : {}),
                },
              },
              cwd: root,
              authMethodId: null,
              clientInfo: { name: "hbots-test", version: "1" },
            }),
        });
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              seen.push(event);
            }),
          ),
          Effect.forkChild,
        );
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        const first = yield* adapter
          .sendTurn({ threadId, input: "long first message" })
          .pipe(Effect.forkChild);
        yield* Effect.sleep("80 millis");
        const second = yield* adapter
          .sendTurn({ threadId, input: "steer message" })
          .pipe(Effect.exit, Effect.forkChild);
        const third = yield* adapter
          .sendTurn({ threadId, input: "another steer" })
          .pipe(Effect.exit, Effect.forkChild);
        const [firstTurn, secondTurn, thirdTurn] = yield* Effect.all([
          Fiber.join(first),
          Fiber.join(second),
          Fiber.join(third),
        ]);
        expect(Exit.isSuccess(secondTurn)).toBe(true);
        if (Exit.isSuccess(secondTurn)) expect(firstTurn.turnId).toBe(secondTurn.value.turnId);
        expect(Exit.isFailure(thirdTurn)).toBe(failSetup === "final" || failSetup === "prompt");
        if (Exit.isSuccess(thirdTurn)) expect(firstTurn.turnId).toBe(thirdTurn.value.turnId);
        expect(seen.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(seen.filter((event) => event.type === "turn.aborted")).toHaveLength(0);
        expect(seen.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(seen.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: {
            state: failSetup === "final" || failSetup === "prompt" ? "failed" : "completed",
          },
        });
        expect((yield* adapter.listSessions())[0]).toMatchObject({
          status: "ready",
          activeTurnId: undefined,
        });
        const requests = yield* fs.readFileString(log);
        if (failSetup !== "middle")
          expect(requests.indexOf("long first message")).toBeLessThan(
            requests.indexOf("steer message"),
          );
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  );
}
