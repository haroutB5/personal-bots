// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { CatalogInstaller, type InstalledAgent } from "../catalog/installer.ts";
import { makeRegistryAcpAdapter } from "./RegistryAcpAdapter.ts";

const threadId = ThreadId.make("registry-adapter-test");
const harness = Effect.fn("registryAdapter.test.harness")(function* (
  extraEnv: Record<string, string> = {},
  nodePath = process.execPath,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-registry-adapter-" });
  const log = path.join(root, "requests.jsonl");
  let leases = 0;
  const agent: InstalledAgent = {
    catalogId: "test-agent",
    version: "1.0.0",
    previousVersion: null,
    kind: "npm",
    agentName: "Mock",
    agentVersion: "1.0.0",
    directory: NodeURL.fileURLToPath(new URL("../../../scripts/", import.meta.url)),
    runner: "node",
    entry: "acp-mock-agent.ts",
    args: [],
    env: {},
  };
  const adapter = yield* makeRegistryAcpAdapter({
    instanceId: ProviderInstanceId.make("registry-test"),
    catalogId: "test-agent",
    nodePath,
    extraEnv: { T3_ACP_REQUEST_LOG_PATH: log, ...extraEnv },
  }).pipe(
    Effect.provideService(
      CatalogInstaller,
      CatalogInstaller.of({
        runtimesRoot: root,
        acquire: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              leases++;
              return agent;
            }),
            () =>
              Effect.sync(() => {
                leases--;
              }),
          ),
        resolve: () => Effect.succeed(agent),
        state: () => Effect.die("unused"),
        changes: () => Stream.empty,
        start: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        remove: () => Effect.void,
        goBack: () => Effect.die("unused"),
      }),
    ),
  );
  return { adapter, fs, root, log, leases: () => leases };
});

it.live(
  "registry ACP forwards output and each prompt's persona, and releases its session lease",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const seen: ProviderRuntimeEvent[] = [];
      yield* h.adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* h.adapter.startSession({ threadId, cwd: h.root, runtimeMode: "approval-required" });
      expect(h.leases()).toBe(1);
      const first = yield* h.adapter.sendTurn({
        threadId,
        input: "hello",
        systemInstructions: "Persona one",
      });
      expect(first.threadId).toBe(threadId);
      yield* h.adapter.sendTurn({ threadId, input: "again", systemInstructions: "Persona two" });
      const log = yield* h.fs.readFileString(h.log);
      expect(log).toContain("Persona one");
      expect(log).toContain("Persona two");
      expect(log).not.toContain('"method":"authenticate"');
      expect(
        seen.some(
          (event) => event.type === "content.delta" && event.payload.delta === "hello from mock",
        ),
      ).toBe(true);
      expect(seen.filter((event) => event.type === "turn.completed")).toHaveLength(2);
      yield* h.adapter.stopSession(threadId);
      expect(h.leases()).toBe(0);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

for (const decision of [
  "accept",
  "decline",
] as const satisfies ReadonlyArray<ProviderApprovalDecision>) {
  it.live(
    `registry ACP permission ${decision} requires an explicit answer`,
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ T3_ACP_EMIT_TOOL_CALLS: "1" });
        let requests = 0;
        yield* h.adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "request.opened"
              ? Effect.gen(function* () {
                  requests++;
                  yield* h.adapter.respondToRequest(
                    threadId,
                    ApprovalRequestId.make(event.requestId!),
                    decision,
                  );
                })
              : Effect.void,
          ),
          Effect.forkChild,
        );
        yield* h.adapter.startSession({ threadId, cwd: h.root, runtimeMode: "approval-required" });
        yield* h.adapter.sendTurn({ threadId, input: "test permission" });
        expect(requests).toBe(1);
        yield* h.adapter.stopAll();
        expect(h.leases()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  );
}

it.live(
  "registry ACP releases the lease when spawning fails",
  () =>
    Effect.gen(function* () {
      const h = yield* harness({}, "C:/missing-hbots-registry-agent/node.exe");
      const error = yield* h.adapter
        .startSession({ threadId, cwd: h.root, runtimeMode: "approval-required" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterProcessError");
      expect(h.leases()).toBe(0);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "registry ACP closes sessions when its owning instance scope closes",
  () =>
    Effect.gen(function* () {
      const leaseCount = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          yield* h.adapter.startSession({
            threadId,
            cwd: h.root,
            runtimeMode: "approval-required",
          });
          expect(h.leases()).toBe(1);
          return h.leases;
        }),
      );
      expect(leaseCount()).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);

for (const [decision, state] of [
  ["accept", "completed"],
  ["cancel", "interrupted"],
] as const) {
  it.live(
    `registry ACP permission ${decision} lets the agent's tool ${state === "completed" ? "run" : "not run"}`,
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ T3_ACP_EMIT_TOOL_CALLS: "1" });
        const seen: ProviderRuntimeEvent[] = [];
        yield* h.adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "request.opened"
              ? h.adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(event.requestId!),
                  decision,
                )
              : Effect.sync(() => {
                  seen.push(event);
                }),
          ),
          Effect.forkChild,
        );
        yield* h.adapter.startSession({ threadId, cwd: h.root, runtimeMode: "approval-required" });
        yield* h.adapter.sendTurn({ threadId, input: "test permission" });
        const completed = seen.find((event) => event.type === "turn.completed");
        expect(completed?.type === "turn.completed" ? completed.payload.state : undefined).toBe(
          state,
        );
        yield* h.adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  );
}
