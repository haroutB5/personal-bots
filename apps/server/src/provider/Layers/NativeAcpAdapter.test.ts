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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { makeNativeAcpAdapter, selectAutoApprovedPermissionOption } from "./NativeAcpAdapter.ts";

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
        .sendTurn({ threadId, input: "second message" })
        .pipe(Effect.forkChild);
      const [firstTurn, secondTurn] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(firstTurn.turnId).not.toBe(secondTurn.turnId);
      expect(seen.filter((event) => event.type === "turn.started")).toHaveLength(2);
      expect(seen.filter((event) => event.type === "turn.completed")).toHaveLength(2);
      const requests = yield* fs.readFileString(log);
      expect(requests.indexOf("first message")).toBeLessThan(requests.indexOf("second message"));
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);
