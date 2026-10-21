// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CatalogInstaller, type InstalledAgent } from "../catalog/installer.ts";
import { ProviderCatalog } from "../catalog/ProviderCatalog.ts";
import { smokeTestRegistryAgent } from "../catalog/registryProbe.ts";
import { RegistryAcpDriver } from "./RegistryAcpDriver.ts";

const mockCatalogEntry = {
  source: "registry" as const,
  website: null,
  repository: null,
  openSource: true,
  version: "1.0.0",
  iconUrl: null,
  distribution: null,
  downloadBytes: null,
  sha256Checked: true,
  cost: { kind: "unknown" as const, label: "Unknown", detail: null },
  signInLabel: null,
  popularRank: null,
  supported: { ok: true as const },
  added: null,
  catalogId: "test-agent",
  name: "Test ACP Agent",
  publisher: "Antigravity Team",
  description: "An agent for testing",
  license: "MIT",
  program: "test-agent",
  args: ["--acp"],
  bundled: false,
  addedByUser: true,
  registryFetchedAt: "2026-10-20T20:00:00.000Z",
};

const mockCatalogLayer = Layer.mock(ProviderCatalog)({
  list: () =>
    Effect.succeed({
      entries: [mockCatalogEntry],
      registryFetchedAt: "2026-10-20T20:00:00.000Z",
      registryStale: false,
    }),
  installFacts: () => Effect.succeed(null),
  installRequest: () => Effect.succeed(null),
  icon: () => Effect.succeed(null),
  refresh: () => Effect.void,
});

// The repository's own mock ACP agent, started the way an installed npm agent is.
const mockAgent: InstalledAgent = {
  catalogId: "test-agent",
  version: "1.0.0",
  previousVersion: null,
  kind: "npm",
  agentName: "test-agent",
  agentVersion: "1.0.0",
  directory: NodeURL.fileURLToPath(new URL("../../../scripts/", import.meta.url)),
  runner: "node",
  entry: "acp-mock-agent.ts",
  args: [],
  env: {},
};

const makeInstallerLayer = (input: { readonly installed: boolean }) =>
  Layer.succeed(
    CatalogInstaller,
    CatalogInstaller.of({
      runtimesRoot: "C:/test-runtimes",
      state: () =>
        Effect.succeed({
          catalogId: "test-agent",
          operationId: "op-1",
          phase: "succeeded",
          downloadedBytes: 1024,
          totalBytes: 1024,
          version: "1.0.0",
          installedVersion: input.installed ? "1.0.0" : null,
          previousVersion: null,
          canRemove: true,
          message: null,
          failure: null,
        }),
      changes: () => Stream.empty,
      start: () => Effect.die(new Error("not used")),
      cancel: () => Effect.die(new Error("not used")),
      remove: () => Effect.void,
      goBack: () => Effect.die(new Error("not used")),
      acquire: () =>
        input.installed
          ? Effect.succeed(mockAgent)
          : Effect.fail({
              _tag: "CatalogInstallError",
              kind: "other",
              detail: "That provider is not installed.",
              message: "That provider is not installed.",
            } as never),
      resolve: () => Effect.succeed(input.installed ? mockAgent : null),
    }),
  );

const makeTestLayer = (input: { readonly installed: boolean }) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-registry-driver-test-" }),
    ServerSettingsService.layerTest(),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
    mockCatalogLayer,
    makeInstallerLayer(input),
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const create = (environment: ReadonlyArray<string> = []) =>
  RegistryAcpDriver.create({
    instanceId: ProviderInstanceId.make("reg-test-1"),
    displayName: "My Custom Agent",
    accentColor: "#ff0000",
    environment: environment.map((name) => ({ name, value: "1", sensitive: false })),
    enabled: true,
    config: { catalogId: "test-agent" },
  });

it.live(
  "RegistryAcpDriver decodes valid config and instantiates correctly",
  () =>
    Effect.gen(function* () {
      expect(RegistryAcpDriver.driverKind).toBe(ProviderDriverKind.make("registry"));
      expect(RegistryAcpDriver.metadata.supportsMultipleInstances).toBe(true);

      const instance = yield* create();
      expect(instance.instanceId).toBe(ProviderInstanceId.make("reg-test-1"));
      expect(instance.driverKind).toBe(ProviderDriverKind.make("registry"));
      expect(instance.continuationIdentity.continuationKey).toBe("registry:instance:reg-test-1");

      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.catalogId).toBe("test-agent");
      expect(snapshot.source).toBe("registry");
      expect(snapshot.displayName).toBe("My Custom Agent");
      expect(snapshot.publisher).toBe("Antigravity Team");
      expect(snapshot.license).toBe("MIT");
      expect(snapshot.openSource).toBe(true);
      expect(snapshot.iconUrl).toBe("/api/provider-catalog/icon/test-agent");
      expect(snapshot.addedByUser).toBe(true);
      expect(snapshot.version).toBe("1.0.0");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.setup?.canTest).toBe(true);
      expect(snapshot.continuation).toEqual({ groupKey: "registry:instance:reg-test-1" });

      const maintenance = yield* instance.snapshot.resolveMaintenance();
      expect(maintenance.update).toBeNull();
      expect(maintenance.provider).toBe(ProviderDriverKind.make("registry"));

      expect(instance.adapter.capabilities.sessionModelSwitch).toBe("in-session");
      expect(instance.adapter.capabilities.promptlessTurnContinuation).toBe(false);
      expect(instance.smokeTest).toBeDefined();

      const textGenError = yield* instance.textGeneration
        .generateCommitMessage({} as never)
        .pipe(Effect.flip);
      expect(textGenError._tag).toBe("TextGenerationError");
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer({ installed: true }))),
  30_000,
);

it.live(
  "the health check starts the agent and publishes its models",
  () =>
    Effect.gen(function* () {
      const instance = yield* create();
      const checked = yield* instance.snapshot.refresh;
      expect(checked.status).toBe("ready");
      expect(checked.auth.status).toBe("unknown");
      expect(checked.message).toBeUndefined();
      expect(checked.models.map((model) => model.slug)).toEqual([
        "default",
        "composer-2",
        "composer-2[fast=true]",
        "gpt-5.3-codex[reasoning=medium,fast=false]",
      ]);
      expect(checked.models.filter((model) => model.isDefault === true)).toHaveLength(1);
      // Reading the snapshot again does not start the agent again.
      expect((yield* instance.snapshot.getSnapshot).models).toEqual(checked.models);
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer({ installed: true }))),
  60_000,
);

it.live(
  "an agent that lists a sign-in method is reported as needing sign-in, with its own hint first",
  () =>
    Effect.gen(function* () {
      const instance = yield* create(["T3_ACP_OFFER_SIGN_IN"]);
      const checked = yield* instance.snapshot.refresh;
      expect(checked.status).toBe("warning");
      expect(checked.auth.status).toBe("unauthenticated");
      const [firstLine, secondLine] = (checked.message ?? "").split("\n");
      expect(firstLine).toBe("Run `mock auth login` in the terminal, then test it again.");
      expect(secondLine).toBe("Sign-in options: Login with Mock.");
      // Its models are still listed, so a bot can be set up before signing in.
      expect(checked.models.length).toBeGreaterThan(0);

      // A passing test message proves the sign-in works.
      yield* instance.smokeTest!({ model: "default" });
      const after = yield* instance.snapshot.getSnapshot;
      expect(after.status).toBe("ready");
      expect(after.auth.status).toBe("authenticated");
      expect(after.message).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer({ installed: true }))),
  90_000,
);

it.live(
  "the test message tells the user to sign in when the agent stays silent",
  () =>
    Effect.gen(function* () {
      const instance = yield* create(["T3_ACP_OFFER_SIGN_IN", "T3_ACP_HANG_PROMPT_FOREVER"]);
      // The driver's own deadline is 45 s; the silent path itself is covered with a short one below.
      const outcome = yield* smokeTestRegistryAgent({
        installer: yield* CatalogInstaller,
        catalogId: "test-agent",
        nodePath: process.execPath,
        hostEnvironment: process.env,
        extraEnv: { T3_ACP_OFFER_SIGN_IN: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
        model: "default",
        firstOutputTimeout: "500 millis",
      });
      expect(outcome.kind).toBe("silent");
      expect(outcome.kind === "silent" ? outcome.authMethods.map((m) => m.id) : []).toEqual([
        "mock-login",
      ]);
      expect(instance.smokeTest).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer({ installed: true }))),
  60_000,
);

it.live(
  "an agent that is not installed is not started and says so",
  () =>
    Effect.gen(function* () {
      const instance = yield* create();
      const checked = yield* instance.snapshot.refresh;
      expect(checked.installed).toBe(false);
      expect(checked.status).toBe("warning");
      expect(checked.message).toBe("My Custom Agent is not installed yet.");
      expect(checked.models).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer({ installed: false }))),
  30_000,
);
