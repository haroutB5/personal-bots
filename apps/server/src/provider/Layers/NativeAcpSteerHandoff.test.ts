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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { makeNativeAcpAdapter } from "./NativeAcpAdapter.ts";

for (const scenario of ["one steer", "two steers", "Stop during handoff"] as const) {
  it.live(
    `a held tool outlives the busy retry window: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-acp-steer-handoff-" });
        const release = path.join(root, "release-tool");
        const log = path.join(root, "requests.jsonl");
        const toolStarted = yield* Deferred.make<void>();
        const threadId = ThreadId.make("held-tool-steer");
        const seen: ProviderRuntimeEvent[] = [];
        const adapter = yield* makeNativeAcpAdapter({
          provider: ProviderDriverKind.make("opencode"),
          instanceId: ProviderInstanceId.make("opencode-handoff-test"),
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
                  T3_ACP_HELD_TOOL_RELEASE_PATH: release,
                },
              },
              cwd: root,
              authMethodId: null,
              clientInfo: { name: "hbots-test", version: "1" },
            }),
        });
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.type === "item.updated" && event.itemId === "held-shell") {
                yield* Deferred.succeed(toolStarted, undefined);
              }
            }),
          ),
          Effect.forkChild,
        );
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        yield* Effect.gen(function* () {
          const original = yield* adapter
            .sendTurn({ threadId, input: "run held tool" })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(toolStarted);
          const steer = yield* adapter
            .sendTurn({ threadId, input: "include STEER_ONE" })
            .pipe(Effect.exit, Effect.forkChild);
          // Observe cancellation at the agent before measuring its busy period.
          while (!(yield* fs.readFileString(log)).includes('"session/cancel"')) {
            yield* Effect.sleep("10 millis");
          }
          const another =
            scenario === "two steers"
              ? yield* adapter
                  .sendTurn({ threadId, input: "include STEER_TWO" })
                  .pipe(Effect.exit, Effect.forkChild)
              : undefined;
          // The command remains in flight beyond all 40 old busy retries.
          yield* Effect.sleep("11 seconds");
          expect(seen.filter((event) => event.type === "turn.completed")).toHaveLength(0);
          expect((yield* adapter.listSessions())[0]).toMatchObject({ status: "running" });
          const beforeRelease = (yield* fs.readFileString(log))
            .split("\n")
            .filter((line) => line.includes('"session/prompt"'));
          expect(beforeRelease).toHaveLength(1);
          if (scenario === "Stop during handoff") {
            yield* adapter.interruptTurn(threadId);
          }
          yield* fs.writeFileString(release, "release");
          const originalResult = yield* Fiber.join(original);
          const steerResult = yield* Fiber.join(steer);
          if (another) expect(Exit.isSuccess(yield* Fiber.join(another))).toBe(true);
          expect(Exit.isSuccess(originalResult)).toBe(true);
          const completed = seen.filter((event) => event.type === "turn.completed");
          if (scenario === "Stop during handoff") {
            expect(seen.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
            expect(completed).toHaveLength(0);
          } else {
            expect(Exit.isSuccess(steerResult)).toBe(true);
            if (Exit.isSuccess(originalResult) && Exit.isSuccess(steerResult)) {
              expect(originalResult.value.turnId).toBe(steerResult.value.turnId);
            }
            expect(seen.filter((event) => event.type === "turn.aborted")).toHaveLength(0);
            expect(completed).toHaveLength(1);
            expect(completed[0]).toMatchObject({ payload: { state: "completed" } });
          }
          expect((yield* adapter.listSessions())[0]).toMatchObject({
            status: "ready",
            activeTurnId: undefined,
          });
          const requests = (yield* fs.readFileString(log))
            .split("\n")
            .filter((line) => line.includes('"session/prompt"'));
          expect(requests).toHaveLength(
            scenario === "Stop during handoff" ? 1 : scenario === "two steers" ? 3 : 2,
          );
          if (scenario !== "Stop during handoff") expect(requests[1]).toContain("STEER_ONE");
          if (scenario === "two steers") expect(requests[2]).toContain("STEER_TWO");
        }).pipe(
          Effect.ensuring(
            fs
              .writeFileString(release, "release")
              .pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.ignore),
          ),
        );
        yield* adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  );
}
