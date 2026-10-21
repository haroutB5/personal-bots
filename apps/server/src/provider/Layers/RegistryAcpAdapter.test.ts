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
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CatalogInstaller, type InstalledAgent } from "../catalog/installer.ts";
import { makeRegistryAuthMemory } from "../catalog/registryAuth.ts";
import { makeRegistryAcpAdapter } from "./RegistryAcpAdapter.ts";

const threadId = ThreadId.make("registry-adapter-test");
const harness = Effect.fn("registryAdapter.test.harness")(function* (
  extraEnv: Record<string, string> = {},
  nodePath = process.execPath,
  extra: { readonly firstOutputTimeout?: Duration.Input } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-registry-adapter-" });
  const log = path.join(root, "requests.jsonl");
  let leases = 0;
  const auth = yield* makeRegistryAuthMemory();
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
    displayName: "Mock",
    auth,
    ...extra,
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
  return { adapter, fs, root, log, auth, leases: () => leases };
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

it.live(
  "registry ACP fails a silent turn quickly with the agent's own sign-in hint, and ends the stuck session",
  () =>
    Effect.gen(function* () {
      const h = yield* harness(
        { T3_ACP_OFFER_SIGN_IN: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
        process.execPath,
        { firstOutputTimeout: "800 millis" },
      );
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
      const startedAt = yield* Clock.currentTimeMillis;
      const error = yield* h.adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.flip);
      expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(10_000);
      expect(error.message).toContain("Mock needs you to sign in");
      expect(error.message).toContain("Run `mock auth login` in the terminal");
      yield* Effect.sleep("100 millis");
      const failed = seen.find((event) => event.type === "turn.completed");
      expect(failed?.type === "turn.completed" ? failed.payload.state : undefined).toBe("failed");
      expect(failed?.type === "turn.completed" ? failed.payload.errorMessage : undefined).toBe(
        "Mock needs you to sign in. Run `mock auth login` in the terminal, then test it again.",
      );
      expect((yield* SubscriptionRef.get(h.auth.state)).verdict).toBe("needed");
      // The stuck process is gone and its lease released, so Remove can proceed.
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      expect(h.leases()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "registry ACP does not fail a turn that is answering, and remembers the agent works",
  () =>
    Effect.gen(function* () {
      const h = yield* harness({ T3_ACP_OFFER_SIGN_IN: "1" }, process.execPath, {
        firstOutputTimeout: "5 seconds",
      });
      yield* h.adapter.startSession({ threadId, cwd: h.root, runtimeMode: "approval-required" });
      yield* h.adapter.sendTurn({ threadId, input: "hello" });
      const state = yield* SubscriptionRef.get(h.auth.state);
      expect(state.verdict).toBe("signedIn");
      expect(state.methods.map((method) => method.id)).toEqual(["mock-login"]);
      yield* h.adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);

it.live(
  "registry ACP switches the agent to the model the bot chose, and refuses one it does not offer",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.adapter.startSession({ threadId, cwd: h.root, runtimeMode: "approval-required" });
      const instanceId = ProviderInstanceId.make("registry-test");
      yield* h.adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection: { instanceId, model: "composer-2" },
      });
      const log = yield* h.fs.readFileString(h.log);
      expect(log).toContain('"method":"session/set_config_option"');
      expect(log).toContain("composer-2");
      const refused = yield* h.adapter
        .sendTurn({
          threadId,
          input: "again",
          modelSelection: { instanceId, model: "not-a-model" },
        })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("ProviderAdapterValidationError");
      expect(refused.message).toContain("does not offer the model 'not-a-model'");
      // The refusal left no half-started turn, so the next turn runs.
      yield* h.adapter.sendTurn({ threadId, input: "third" });
      yield* h.adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);
