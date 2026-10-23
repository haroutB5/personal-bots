// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeNativeAcpAdapter } from "./NativeAcpAdapter.ts";

const retrySignal = vi.hoisted(() => ({ entered: () => {} }));
vi.mock("effect/Effect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/Effect")>();
  return {
    ...actual,
    sleep: (duration: Parameters<typeof actual.sleep>[0]) =>
      duration === "250 millis"
        ? actual.sync(() => retrySignal.entered()).pipe(actual.andThen(actual.sleep(duration)))
        : actual.sleep(duration),
  };
});

it.live(
  "Stop during a busy refusal prevents another prompt from being sent",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-stop-retry-" });
      const log = path.join(root, "requests.jsonl");
      yield* fs.writeFileString(log, "");
      const retryStarted = new Promise<void>((resolve) => {
        retrySignal.entered = resolve;
      });
      const adapter = yield* makeNativeAcpAdapter({
        provider: ProviderDriverKind.make("opencode"),
        instanceId: ProviderInstanceId.make("opencode-stop-test"),
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
                T3_ACP_DEFECT_PROMPT_ERROR:
                  "Internal error: Session already has an active ACP prompt: ses_mock",
                T3_ACP_DEFECT_PROMPT_COUNT: "1",
              },
            },
            cwd: root,
            authMethodId: null,
            clientInfo: { name: "hbots-test", version: "1" },
          }),
      });
      const threadId = ThreadId.make("stop-during-busy-test");
      yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
      const pending = yield* adapter
        .sendTurn({ threadId, input: "stop this retry" })
        .pipe(Effect.forkChild);
      // Stop after the busy response entered its retry wait, before another request.
      yield* Effect.tryPromise(() => retryStarted);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(pending);
      const requests = (yield* fs.readFileString(log))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.filter((request) => request.method === "session/prompt")).toHaveLength(1);
      expect((yield* adapter.listSessions())[0]).toMatchObject({
        status: "ready",
        activeTurnId: undefined,
      });
      yield* adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  15_000,
);
