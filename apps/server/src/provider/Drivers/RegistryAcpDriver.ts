/**
 * RegistryAcpDriver — Generic ProviderDriver for agents installed from the ACP registry.
 *
 * An instance of this driver is created per added registry agent, configured with
 * { catalogId }. Sessions acquire a lease from CatalogInstaller to prevent removal
 * while running, then launch an AcpSessionRuntime via toSpawnInput.
 *
 * @module provider/Drivers/RegistryAcpDriver
 */
import {
  ProviderDriverKind,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Crypto from "effect/Crypto";

import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ServerConfig } from "../../config.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { defaultIconUrlFor, isOpenSourceLicense } from "../catalog/entries.ts";
import { CatalogInstaller } from "../catalog/installer.ts";
import { resolveNodePath } from "../catalog/launch.ts";
import { ProviderCatalog } from "../catalog/ProviderCatalog.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeRegistryAcpAdapter } from "../Layers/RegistryAcpAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("registry");

export const RegistryAcpConfig = Schema.Struct({
  catalogId: Schema.String,
});
export type RegistryAcpConfig = typeof RegistryAcpConfig.Type;

export type RegistryAcpDriverEnv =
  | CatalogInstaller
  | ProviderCatalog
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ProviderEventLoggers;

export const RegistryAcpDriver: ProviderDriver<RegistryAcpConfig, RegistryAcpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Registry Agent",
    supportsMultipleInstances: true,
  },
  configSchema: RegistryAcpConfig,
  defaultConfig: () => ({ catalogId: "" }),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const installer = yield* CatalogInstaller;
      const catalog = yield* ProviderCatalog;
      const catalogId = config.catalogId;

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const nodePath = yield* resolveNodePath(process.env).pipe(Effect.orElseSucceed(() => null));

      const readSnapshot = Effect.gen(function* () {
        const installState = yield* installer.state(catalogId);
        const installed = yield* installer.resolve(catalogId);
        const entries = yield* catalog.list({}).pipe(Effect.map((res) => res.entries), Effect.orElseSucceed(() => []));
        const entry = entries.find((e) => e.catalogId === catalogId);
        const nowIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

        const isInstalled = installed !== null;
        const version = installed?.version ?? (isInstalled && installState.version ? installState.version : null);
        const previousVersion = installed?.previousVersion ?? installState.previousVersion ?? null;

        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName || entry?.name || catalogId,
          ...(accentColor ? { accentColor } : {}),
          continuation: {
            groupKey: continuationIdentity.continuationKey,
          },
          enabled,
          installed: isInstalled,
          version,
          previousVersion,
          status: !enabled ? "disabled" : "ready",
          auth: { status: "unknown" },
          checkedAt: nowIso,
          models: [],
          slashCommands: [],
          skills: [],
          setup: {
            canAuthenticate: false,
            canInstall: true,
            canRemove: true,
            canTest: false,
            canOpenOnLaptop: false,
          },
          catalogId,
          source: "registry",
          publisher: entry?.publisher ?? null,
          license: entry?.license ?? null,
          openSource: isOpenSourceLicense(entry?.license ?? null),
          iconUrl: defaultIconUrlFor(catalogId),
          addedByUser: true,
          showUsage: false,
          install:
            installState.phase !== "idle" && installState.phase !== "succeeded"
              ? {
                  phase: installState.phase,
                  downloadedBytes: installState.downloadedBytes,
                  totalBytes: installState.totalBytes,
                }
              : null,
        } satisfies ServerProvider;
      });

      const snapshot: ServerProviderShape = {
        getSnapshot: readSnapshot,
        refresh: readSnapshot,
        streamChanges: Stream.concat(
          Stream.fromEffect(readSnapshot),
          installer.changes(catalogId).pipe(
            Stream.mapEffect(() => readSnapshot),
          ),
        ),
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          ),
        applyUsageLimits: () => Effect.void,
      };

      const textGeneration: TextGeneration.TextGeneration["Service"] = {
        generateCommitMessage: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generate", detail: "Text generation is not supported for registry providers." }),
          ),
        generatePrContent: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generate", detail: "Text generation is not supported for registry providers." }),
          ),
        generateThreadTitle: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generate", detail: "Text generation is not supported for registry providers." }),
          ),
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generate", detail: "Text generation is not supported for registry providers." }),
          ),
      };

      const adapter = yield* makeRegistryAcpAdapter({
        instanceId,
        catalogId,
        nodePath,
        hostEnvironment: process.env,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
