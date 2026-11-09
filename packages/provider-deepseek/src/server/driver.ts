/** DeepSeek's provider driver: one identity, one Flash catalog, two engines behind a seam. */
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

import { DeepSeekSettings } from "../settings.ts";
import { resolveDeepSeekModelCatalog } from "./catalog.ts";
import { DeepSeekEngineHost, makeDeepSeekEngineAdapter } from "./engineAdapter.ts";
import { makeDeepSeekContinuationGroupKey, makeDeepSeekEnvironment } from "./environment.ts";
import { resolveDeepSeekEngine } from "./engine.ts";
import { buildInitialDeepSeekProviderSnapshot, checkDeepSeekProviderStatus } from "./status.ts";
import { makeDeepSeekTextGeneration } from "./textGeneration.ts";
import { deepSeekUsageReader, type DeepSeekUsageReaderEnv } from "./usage.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const DRIVER_KIND = ProviderDriverKind.make("deepseek");

export type DeepSeekDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | DeepSeekEngineHost
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderHost.ProviderHost
  | SecureRandom.SecureRandom;

// peakSwitch only changes the next turn's model; every other config key feeds create
// and must rebuild the instance.
const DEEPSEEK_REBUILD_IRRELEVANT_CONFIG_KEYS = ["peakSwitch"] as const;

export const DeepSeekDriver: ProviderDriver<
  DeepSeekSettings,
  DeepSeekDriverEnv,
  DeepSeekUsageReaderEnv
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "DeepSeek",
    supportsMultipleInstances: true,
  },
  configSchema: DeepSeekSettings,
  defaultConfig: (): DeepSeekSettings => decodeDeepSeekSettings({}),
  rebuildIrrelevantConfigKeys: DEEPSEEK_REBUILD_IRRELEVANT_CONFIG_KEYS,
  usage: deepSeekUsageReader,
  create: Effect.fn("DeepSeekDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* DeepSeekEngineHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const catalogService = yield* ModelCatalog.ModelCatalog;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const effectiveConfig = { ...config, enabled } satisfies DeepSeekSettings;
    const deepSeekEnv = yield* makeDeepSeekEnvironment(effectiveConfig, processEnv);
    const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const continuationGroupKey = yield* makeDeepSeekContinuationGroupKey(
      effectiveConfig,
      processEnv,
    );
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey,
    });
    const modelCatalog = Effect.map(
      catalogService.current(DRIVER_KIND),
      resolveDeepSeekModelCatalog,
    );
    const textGeneration = yield* makeDeepSeekTextGeneration(
      host.createTextGeneration,
      effectiveConfig,
      deepSeekEnv,
      catalogService.current(DRIVER_KIND),
    );
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
      ),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DeepSeekSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        modelCatalog.pipe(
          Effect.flatMap((catalog) =>
            buildInitialDeepSeekProviderSnapshot(settings.provider, catalog),
          ),
          Effect.map(stampIdentity),
        ),
      checkProvider: modelCatalog.pipe(
        Effect.flatMap((catalog) =>
          checkDeepSeekProviderStatus(effectiveConfig, deepSeekEnv, catalog).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        ),
        Effect.map(stampIdentity),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build DeepSeek snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );
    const orchestrationAdapter = yield* makeDeepSeekEngineAdapter({
      instanceId,
      engine: resolveDeepSeekEngine(effectiveConfig, processEnv),
      settings: effectiveConfig,
      environment: deepSeekEnv,
      providerCatalog: catalogService.current(DRIVER_KIND),
      selfInvocation: yield* resolveSelfInvocation(),
      ...(displayName === undefined ? {} : { displayName }),
      ...(accentColor === undefined ? {} : { accentColor }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build DeepSeek orchestration adapter.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity: {
        ...fallbackContinuationIdentity,
        continuationKey: continuationGroupKey,
      },
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
