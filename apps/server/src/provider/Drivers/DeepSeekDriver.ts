/**
 * DeepSeekDriver — `ProviderDriver` for DeepSeek V4.1 Flash.
 *
 * Reuses the Claude Agent SDK runtime against DeepSeek's Anthropic-compatible
 * endpoint (`https://api.deepseek.com/anthropic`). No new agent loop: the
 * adapter, persona (`withBotInstructions`), streaming, tools/MCP,
 * cancellation, and resume/second turns all come from the Claude runtime;
 * this driver pins the endpoint, credential, config home, catalog, and
 * identity to DeepSeek.
 *
 * Identity: `driverKind` is `deepseek`, continuation keys are
 * `deepseek:home:<dir>`, and the adapter wrapper stamps sessions, events,
 * and errors as `deepseek`. Model selection is Flash-only.
 *
 * @module provider/Drivers/DeepSeekDriver
 */
import { DeepSeekSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeDeepSeekTextGeneration } from "../../textGeneration/DeepSeekTextGeneration.ts";
import * as UsageService from "../../usage/UsageService.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  resolveDeepSeekCatalogApiModelId,
  resolveDeepSeekModelCatalog,
  resolveDeepSeekModelSlug,
} from "../DeepSeekModelCatalog.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDeepSeekAdapter } from "../Layers/DeepSeekAdapter.ts";
import {
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
} from "../Layers/DeepSeekProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { runClaudeSmokeTest } from "../providerSmokeTest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import {
  DEEPSEEK_AUTH_TOKEN_ENV,
  makeDeepSeekContinuationGroupKey,
  makeDeepSeekEnvironment,
  resolveDeepSeekHomePath,
} from "./DeepSeekEnvironment.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const DRIVER_KIND = ProviderDriverKind.make("deepseek");

export type DeepSeekDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService
  // The probe prices DeepSeek's own transcripts through the usage scan.
  | UsageService.UsageService;

export const DeepSeekDriver: ProviderDriver<DeepSeekSettings, DeepSeekDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "DeepSeek",
    supportsMultipleInstances: true,
  },
  configSchema: DeepSeekSettings,
  defaultConfig: (): DeepSeekSettings => decodeDeepSeekSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const usageService = yield* UsageService.UsageService;
      const eventLoggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const modelCatalog = Effect.map(modelManifest.current, (manifest) =>
        resolveDeepSeekModelCatalog(manifest),
      );
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies DeepSeekSettings;
      const deepSeekEnv = yield* makeDeepSeekEnvironment(effectiveConfig, processEnv);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const continuationGroupKey = yield* makeDeepSeekContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const configDir = yield* resolveDeepSeekHomePath(effectiveConfig, processEnv);
      // The instance's own transcript directory (Claude-format `projects`
      // JSONL). Resolved the same way the usage scan resolves it, so the
      // probe's spend read shares the scan's per-file cache.
      const projectsDirectory = path.join(configDir, "projects");
      const spendDirectory = yield* fileSystem
        .realPath(projectsDirectory)
        .pipe(Effect.orElseSucceed(() => projectsDirectory));
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      // The inner Claude runtime accepts a catalog effect; the DeepSeek
      // catalog is structurally identical (same profile shapes), and the
      // DeepSeek adapter wrapper validates Flash-only selection on top.
      const adapter = yield* makeDeepSeekAdapter(effectiveConfig, {
        instanceId,
        environment: deepSeekEnv,
        // biome-ignore lint/suspicious/noExplicitAny: DeepSeek catalog reuses the Claude profile shapes by design.
        modelCatalog: modelCatalog as any,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeDeepSeekTextGeneration(
        effectiveConfig,
        deepSeekEnv,
        modelCatalog,
      );

      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "@anthropic-ai/claude-code",
          }),
        ),
      );

      const checkProvider = modelCatalog.pipe(
        Effect.flatMap((catalog) =>
          checkDeepSeekProviderStatus(effectiveConfig, deepSeekEnv, catalog, {
            readSpent: () => usageService.readDeepSeekSpend(spendDirectory),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
        Effect.map(stampIdentity),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DeepSeekSettings>>(
        {
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
        },
      ).pipe(
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
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverClaudeSkills({ homePath: effectiveConfig.homePath }, cwd, deepSeekEnv),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );

      const smokeTest: NonNullable<ProviderInstance["smokeTest"]> = ({ model }) =>
        Effect.gen(function* () {
          const catalog = yield* modelCatalog;
          const token = deepSeekEnv[DEEPSEEK_AUTH_TOKEN_ENV]?.trim() ?? "";
          if (!token) {
            return yield* new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail:
                "DeepSeek API key is missing. Add ANTHROPIC_AUTH_TOKEN as a sensitive environment variable on this DeepSeek instance.",
            });
          }
          const resolved = resolveDeepSeekModelSlug(catalog, model);
          const executablePath = yield* resolveClaudeSdkExecutablePath(
            effectiveConfig.binaryPath,
            deepSeekEnv,
          );
          yield* runClaudeSmokeTest({
            instanceId,
            executablePath,
            environment: deepSeekEnv,
            model: resolveDeepSeekCatalogApiModelId(catalog, {
              instanceId,
              model: resolved,
            } as never),
          }).pipe(
            Effect.mapError((cause) => {
              const tag = (cause as { _tag?: unknown })._tag;
              if (tag === "ProviderDriverError") {
                const driverError = cause as ProviderDriverError;
                return new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: driverError.detail,
                  ...(driverError.cause === undefined ? {} : { cause: driverError.cause }),
                });
              }
              return cause;
            }),
          );
        }).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
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
        snapshotForCwd,
        adapter,
        textGeneration,
        smokeTest,
      } satisfies ProviderInstance;
    }),
};
