/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import { makeClaudeScopedLimitNames } from "../Layers/claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../Layers/claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  mergeDiscoveredClaudeModels,
  resolveClaudeCatalogApiModelId,
  resolveClaudeModelCatalog,
} from "../ClaudeModelCatalog.ts";
import { runClaudeSmokeTest } from "../providerSmokeTest.ts";
import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  confirmUsageAfterReset,
  RESET_FOLLOW_UP_DELAYS,
  RESET_LAGGING_WARNING,
  RESET_UNCONFIRMED_WARNING,
} from "../resetCreditConfirmation.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { discoverClaudeModelSlugs } from "./ClaudeModelDiscovery.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, providerStatusCacheDir } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const discoveredModelSlugs = yield* Ref.make<ReadonlyArray<string>>([]);
      const modelCatalog = Effect.all([modelManifest.current, Ref.get(discoveredModelSlugs)]).pipe(
        Effect.map(([manifest, discoveredSlugs]) =>
          mergeDiscoveredClaudeModels(resolveClaudeModelCatalog(manifest), discoveredSlugs),
        ),
      );
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies ClaudeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
      const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
        effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
          ? configDir
          : undefined,
      );
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      // One per instance: the status probe writes the model-scoped bucket
      // names it saw, the adapter reads them to place turn-driven events.
      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const adapterOptions = {
        instanceId,
        environment: processEnv,
        modelCatalog,
        scopedLimitNames,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        cwd,
        processEnv,
      );
      const modelDiscoveryCachePath = path.join(
        providerStatusCacheDir,
        "claude-model-discovery.json",
      );
      const resolveInstalledModelCatalog = (cliVersion: string) =>
        Effect.gen(function* () {
          const claudeEnvironment = yield* makeClaudeEnvironment(effectiveConfig, processEnv);
          const sdkExecutablePath = yield* resolveClaudeSdkExecutablePath(
            effectiveConfig.binaryPath,
            claudeEnvironment,
          );
          const platform = yield* HostProcessPlatform;
          const resolveExecutable = yield* SpawnExecutableResolution;
          const executablePath =
            resolveExecutable(sdkExecutablePath, platform, claudeEnvironment) ?? sdkExecutablePath;
          const slugs = yield* discoverClaudeModelSlugs({
            executablePath,
            cliVersion,
            cachePath: modelDiscoveryCachePath,
          });
          yield* Ref.set(discoveredModelSlugs, slugs);
          return yield* modelCatalog;
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = modelManifest.refreshInBackground.pipe(
        Effect.andThen(
          modelCatalog.pipe(
            Effect.flatMap((catalog) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                // A probe that could not read usage (or failed outright) is not
                // kept for the TTL, or the early retry after a failed read
                // would be served the same miss.
                () =>
                  Cache.get(capabilitiesProbeCache, capabilitiesCacheKey).pipe(
                    Effect.tap((capabilities) =>
                      capabilities?.usage === undefined
                        ? Cache.invalidate(capabilitiesProbeCache, capabilitiesCacheKey)
                        : Effect.void,
                    ),
                  ),
                processEnv,
                cwd,
                catalog,
                scopedLimitNames,
                (version) =>
                  ClaudeResetCredits.readClaudeResetCredits(configDir, version).pipe(
                    Effect.provideService(HttpClient.HttpClient, httpClient),
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                  ),
                resolveInstalledModelCatalog,
              ),
            ),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelCatalog.pipe(
            Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverClaudeSkills(effectiveConfig, cwd, processEnv),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );

      // Same executable resolution and environment as the adapter's sessions.
      const smokeTest: NonNullable<ProviderInstance["smokeTest"]> = ({ model }) =>
        Effect.gen(function* () {
          const environment = yield* makeClaudeEnvironment(effectiveConfig, processEnv);
          const executablePath = yield* resolveClaudeSdkExecutablePath(
            effectiveConfig.binaryPath,
            environment,
          );
          const catalog = yield* modelCatalog;
          yield* runClaudeSmokeTest({
            instanceId,
            executablePath,
            environment,
            model: resolveClaudeCatalogApiModelId(catalog, { instanceId, model }),
          });
        }).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

      // Same rules as Codex: serialised on the config directory that holds the
      // login, one request id kept until Claude answers (a cooldown or rate
      // limit is an answer), then a re-probe.
      const reprobeUsage = Cache.invalidateAll(capabilitiesProbeCache).pipe(
        Effect.andThen(snapshot.refresh),
        Effect.map((refreshed) => refreshed.usageLimits),
        // The claim already landed; a failed read must not report it as failed.
        Effect.orElseSucceed(() => undefined),
      );
      const driverScope = yield* Effect.scope;
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        Effect.gen(function* () {
          const current = yield* snapshot.getSnapshot;
          const grantId = current.usageLimits?.resetCredits?.nextCreditId;
          if (!grantId || !current.version) return { outcome: "noCredit" as const };
          const version = current.version;
          const outcome = yield* resetCreditCoordinator.redeem(
            configDir,
            (requestId) =>
              ClaudeResetCredits.consumeClaudeResetCredit({
                configDir,
                accountConfigPath,
                version,
                grantId,
                requestId,
              }),
            ClaudeResetCredits.isSettledClaudeResetCreditFailure,
          );
          if (outcome !== "reset") {
            // Nothing changed on the account; one re-read picks up the credit count.
            yield* reprobeUsage;
            return { outcome };
          }
          // Anthropic's usage endpoint can trail the claim by a few seconds.
          // Re-read until it shows the reset, and never leave a pre-reset read
          // in the probe cache, or every refresh for the next five minutes
          // serves it again as "Updated now".
          const confirmation = yield* confirmUsageAfterReset({
            before: current.usageLimits,
            reprobe: reprobeUsage,
          });
          if (confirmation === "confirmed") return { outcome };
          yield* Cache.invalidateAll(capabilitiesProbeCache);
          yield* confirmUsageAfterReset({
            before: current.usageLimits,
            reprobe: reprobeUsage,
            delays: RESET_FOLLOW_UP_DELAYS,
          }).pipe(
            Effect.tap((later) =>
              Effect.logInfo("Claude usage after a redeemed reset", { confirmation: later }),
            ),
            Effect.andThen(Cache.invalidateAll(capabilitiesProbeCache)),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(driverScope),
          );
          return {
            outcome,
            warning: confirmation === "lagging" ? RESET_LAGGING_WARNING : RESET_UNCONFIRMED_WARNING,
          };
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause._tag === "ClaudeResetCreditError"
                    ? cause.message
                    : "Claude could not redeem the reset.",
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
        invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
        invalidateUsage: Cache.invalidateAll(capabilitiesProbeCache),
        snapshotForCwd,
        adapter,
        textGeneration,
        smokeTest,
        consumeResetCredit,
      } satisfies ProviderInstance;
    }),
};
