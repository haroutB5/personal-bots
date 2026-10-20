// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CatalogInstaller } from "../catalog/installer.ts";
import { ProviderCatalog } from "../catalog/ProviderCatalog.ts";
import { RegistryAcpConfig, RegistryAcpDriver } from "./RegistryAcpDriver.ts";

const mockCatalogEntry = {
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

const mockInstallerLayer = Layer.mock(CatalogInstaller)({
  runtimesRoot: "C:/test-runtimes",
  state: () =>
    Effect.succeed({
      catalogId: "test-agent",
      operationId: "op-1",
      phase: "succeeded",
      downloadedBytes: 1024,
      totalBytes: 1024,
      version: "1.0.0",
      installedVersion: "1.0.0",
      previousVersion: null,
      canRemove: true,
      message: null,
      failure: null,
    }),
  changes: () => Stream.empty,
  start: () => Effect.dieMessage("not used"),
  cancel: () => Effect.dieMessage("not used"),
  remove: () => Effect.void,
  goBack: () => Effect.dieMessage("not used"),
  acquire: () => Effect.dieMessage("not used"),
  resolve: () =>
    Effect.succeed({
      catalogId: "test-agent",
      version: "1.0.0",
      previousVersion: null,
      runtimePath: "C:/test-runtimes/test-agent",
      packageRoot: "C:/test-runtimes/test-agent/node_modules/test-agent",
      manifest: {
        name: "test-agent",
        version: "1.0.0",
        program: "bin/cli.js",
        args: ["--acp"],
        environment: "node",
      },
      installedAt: "2026-10-20T20:00:00.000Z",
    }),
});

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-registry-driver-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(mockCatalogLayer),
  Layer.provideMerge(mockInstallerLayer),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

it.effect("RegistryAcpDriver decodes valid config and instantiates correctly", () =>
  Effect.gen(function* () {
    expect(RegistryAcpDriver.driverKind).toBe(ProviderDriverKind.make("registry"));
    expect(RegistryAcpDriver.metadata.supportsMultipleInstances).toBe(true);

    const instanceId = ProviderInstanceId.make("reg-test-1");
    const instance = yield* RegistryAcpDriver.create({
      instanceId,
      displayName: "My Custom Agent",
      accentColor: "#ff0000",
      environment: { kind: "host" },
      enabled: true,
      config: { catalogId: "test-agent" },
    });

    expect(instance.instanceId).toBe(instanceId);
    expect(instance.driverKind).toBe(ProviderDriverKind.make("registry"));
    expect(instance.continuationIdentity.continuationKey).toBe("registry:instance:reg-test-1");

    // Snapshot verification
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
    expect(snapshot.setup).toEqual({
      canAuthenticate: false,
      canInstall: true,
      canRemove: true,
      canTest: false,
      canOpenOnLaptop: false,
    });
    expect(snapshot.continuation).toEqual({
      groupKey: "registry:instance:reg-test-1",
    });

    // Maintenance verification
    const maintenance = yield* instance.snapshot.resolveMaintenance();
    expect(maintenance.update).toBeNull();
    expect(maintenance.provider).toBe(ProviderDriverKind.make("registry"));

    // Adapter capabilities
    expect(instance.adapter.capabilities.sessionModelSwitch).toBe("unsupported");
    expect(instance.adapter.capabilities.promptlessTurnContinuation).toBe(false);

    // Text generation is unsupported
    const textGenError = yield* instance.textGeneration.generateCommitMessage({} as any).pipe(
      Effect.flip,
    );
    expect(textGenError._tag).toBe("TextGenerationError");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
