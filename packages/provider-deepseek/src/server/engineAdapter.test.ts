// @effect-diagnostics nodeBuiltinImport:off
// The engine seam: one branch builds the real dsh adapter, the other the
// injected Claude adapter. A dsh thread must open instead of hitting D2's
// placeholder refusal.
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import { DeepSeekSettings } from "../settings.ts";
import { dshTestAgentPath } from "./dshTestAgent.ts";
import {
  DeepSeekEngineHost,
  makeDeepSeekEngineAdapter,
  type DeepSeekEngineHostService,
} from "./engineAdapter.ts";

const DEEPSEEK = ProviderDriverKind.make("deepseek");
const instanceId = ProviderInstanceId.make("deepseek-engine-test");
const threadId = ThreadId.make("thread-deepseek-engine");
const decodeSettings = Schema.decodeSync(DeepSeekSettings);

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
});

const testLayer = TestProviderHost.layer().pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      IdAllocator.layer,
      McpProviderSessions.layer,
    ),
  ),
);

const markerSession = (): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
  instanceId,
  driver: DEEPSEEK,
  providerSessionId: ProviderSessionId.make("marker-session"),
  providerSession: {
    id: ProviderSessionId.make("marker-session"),
    driver: DEEPSEEK,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "claude-adapter-marker",
    model: "deepseek-flash",
    capabilities: AcpProviderCapabilitiesV2,
    createdAt: DateTime.nowUnsafe(),
    updatedAt: DateTime.nowUnsafe(),
    lastError: null,
  },
  events: Stream.empty,
  ensureThread: () => Effect.die("marker ensureThread"),
  resumeThread: () => Effect.die("marker resumeThread"),
  startTurn: () => Effect.die("marker startTurn"),
  steerTurn: () => Effect.die("marker steerTurn"),
  interruptTurn: () => Effect.die("marker interruptTurn"),
  respondToRuntimeRequest: () => Effect.die("marker respondToRuntimeRequest"),
  readThreadSnapshot: () => Effect.die("marker readThreadSnapshot"),
  rollbackThread: () => Effect.die("marker rollbackThread"),
  forkThread: () => Effect.die("marker forkThread"),
});

const markerAdapter = () =>
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver: DEEPSEEK,
    getCapabilities: () => Effect.succeed(AcpProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: () => Effect.succeed(markerSession()),
  });

const hostLayer = (createClaudeAdapter: DeepSeekEngineHostService["createClaudeAdapter"]) =>
  Layer.succeed(DeepSeekEngineHost, {
    createClaudeAdapter,
    registerProcess: () => {},
    forgetProcess: () => {},
  });

const openInput = () => ({
  threadId,
  providerSessionId: ProviderSessionId.make("provider-session-engine"),
  modelSelection: { instanceId, model: "deepseek-flash" },
  runtimePolicy,
});

it.layer(testLayer)("DeepSeekEngineAdapter", (it) => {
  it.effect("opens a real dsh session instead of the placeholder refusal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-seam-" });
      const requestLog = path.join(baseDir, "requests.ndjson");
      const settings = decodeSettings({
        enabled: true,
        engine: "dsh",
        dshRuntimePath: path.join(baseDir, "runtime"),
      });
      const adapter = yield* makeDeepSeekEngineAdapter({
        instanceId,
        engine: "dsh",
        settings,
        environment: {},
        providerCatalog: Effect.undefined,
        selfInvocation: yield* resolveSelfInvocation(),
        dshTest: {
          dshHome: path.join(baseDir, "dsh"),
          spawnForTest: ({ environment, cwd }) => ({
            command: process.execPath,
            args: ["--disable-warning=ExperimentalWarning", dshTestAgentPath],
            cwd,
            env: {
              ...process.env,
              ...environment,
              T3_ACP_REQUEST_LOG_PATH: requestLog,
            },
            extendEnv: false,
          }),
        },
      }).pipe(
        Effect.provide(
          hostLayer(() => Effect.die("the claude adapter factory must not run on dsh")),
        ),
      );

      const session = yield* adapter.openSession(openInput());
      expect(session.driver).toBe("deepseek");
      expect(session.providerSession.status).toBe("ready");
      const methods = NodeFS.readFileSync(requestLog, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => (JSON.parse(line) as { readonly method?: string }).method);
      expect(methods.slice(0, 2)).toEqual(["initialize", "auth/login"]);
    }),
  );

  it.effect("selects the injected Claude adapter for the claude-code engine", () =>
    Effect.gen(function* () {
      let factoryCalls = 0;
      const adapter = yield* makeDeepSeekEngineAdapter({
        instanceId,
        engine: "claude-code",
        settings: decodeSettings({ enabled: true, engine: "claude-code" }),
        environment: {},
        providerCatalog: Effect.undefined,
        selfInvocation: yield* resolveSelfInvocation(),
      }).pipe(
        Effect.provide(
          hostLayer(() => {
            factoryCalls += 1;
            return Effect.succeed(markerAdapter());
          }),
        ),
      );

      expect(adapter.driver).toBe("deepseek");
      const session = yield* adapter.openSession(openInput());
      expect(factoryCalls).toBe(1);
      expect(session.providerSession.cwd).toBe("claude-adapter-marker");
    }),
  );
});
