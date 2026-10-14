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

import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as EffectAcpErrors from "effect-acp/errors";

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
import { makeDeepSeekDshAdapter } from "../Layers/DeepSeekDshAdapter.ts";
import {
  buildDshEnvironment,
  makeDshAcpRuntime,
  resolveDshRuntime,
  type DshRuntime,
} from "../acp/DshAcpSupport.ts";
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
import { DSH_HOME_DIR_NAME, resolveDeepSeekEngine } from "./DeepSeekEngine.ts";
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

/** The npm package the Claude engine runs on, and looks up updates for. */
const CLAUDE_CODE_PACKAGE_NAME = "@anthropic-ai/claude-code";

/** How long the harness smoke test waits for its ACP handshake. */
const DSH_SMOKE_TIMEOUT = Duration.seconds(90);

/**
 * The harness's equivalent of the Claude binary's smoke test: spawn the pinned
 * runtime in ACP mode and complete one `initialize` handshake with it. A real
 * model request needs a session and a key, which the first turn exercises.
 */
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

const runDshSmokeTest = (input: {
  readonly runtime: DshRuntime;
  readonly environment: NodeJS.ProcessEnv;
  readonly dshHome: string;
  readonly cwd: string;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = yield* buildDshEnvironment({
      instanceEnv: input.environment,
      runtimeMode: "full-access",
      dshHome: input.dshHome,
    });
    const acp = yield* makeDshAcpRuntime({
      childProcessSpawner: spawner,
      spawn: {
        command: process.execPath,
        args: [input.runtime.binJs, "--profile", "acp"],
        cwd: input.cwd,
        env: environment,
      },
      cwd: input.cwd,
    });
    yield* acp.initialize().pipe(Effect.asVoid);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(DSH_SMOKE_TIMEOUT),
    Effect.result,
    Effect.map((outcome) => {
      if (Result.isFailure(outcome)) {
        return {
          ok: false as const,
          detail: isAcpError(outcome.failure) ? outcome.failure.message : String(outcome.failure),
        };
      }
      return Option.isSome(outcome.success)
        ? { ok: true as const }
        : {
            ok: false as const,
            detail:
              "it did not answer its handshake in time. Check the runtime install (scripts/personal/install-dsh.ps1)",
          };
    }),
  );

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
      const cryptoService = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
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
      // One account, two engines: the harness writes its own Claude-shaped
      // ledger beside its home, and the Claude engine's own transcripts stay
      // where they are, so the balance card's "spent" covers both.
      const engine = resolveDeepSeekEngine(effectiveConfig, processEnv);
      // The harness home sits beside the data root, as the design names it:
      // `%USERPROFILE%/.personal-bots/dev/dsh`, not inside `userdata`.
      const dshHome = path.join(serverConfig.baseDir, DSH_HOME_DIR_NAME);
      const ledgerDirectory = path.join(dshHome, "usage");
      const readSpend = () =>
        Effect.all([
          usageService.readDeepSeekSpend(spendDirectory),
          engine === "dsh" ? usageService.readDeepSeekSpend(ledgerDirectory) : Effect.succeed(null),
        ]).pipe(
          Effect.map(([transcripts, ledger]) => {
            const parts = [transcripts, ledger].filter(
              (part): part is NonNullable<typeof part> => part !== null,
            );
            if (parts.length === 0) return null;
            if (parts.length === 1) return parts[0]!;
            return {
              costUsd: parts.reduce((total, part) => total + part.costUsd, 0),
              since: parts.reduce(
                (earliest, part) => (part.since < earliest ? part.since : earliest),
                parts[0]!.since,
              ),
              records: parts.reduce((total, part) => total + part.records, 0),
            } satisfies (typeof parts)[number];
          }),
        );
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      yield* Effect.logInfo("deepseek.engine.selected", { instanceId, engine });
      // The inner Claude runtime accepts a catalog effect; the DeepSeek
      // catalog is structurally identical (same profile shapes), and the
      // DeepSeek adapter wrapper validates Flash-only selection on top.
      const adapter =
        engine === "dsh"
          ? yield* makeDeepSeekDshAdapter({
              instanceId,
              runtime: yield* resolveDshRuntime(effectiveConfig),
              dshHome,
              environment: deepSeekEnv,
              childProcessSpawner: spawner,
              ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
            })
          : yield* makeDeepSeekAdapter(effectiveConfig, {
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

      // The update advisory compares the running version with the npm latest
      // of `packageName`. Only the Claude engine has such a channel: the
      // harness is pinned, and moves only with `install-dsh.ps1` and a new
      // pin. On dsh the comparison was against the Claude CLI's latest, so
      // the card read "Update available" beside the harness version as soon
      // as that moved. No package means no lookup and no advisory.
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: engine === "dsh" ? null : CLAUDE_CODE_PACKAGE_NAME,
          }),
        ),
      );

      const checkProvider = modelCatalog.pipe(
        Effect.flatMap((catalog) =>
          checkDeepSeekProviderStatus(effectiveConfig, deepSeekEnv, catalog, {
            readSpent: () => readSpend(),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
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
          if (engine === "dsh") {
            // The harness's own equivalent of the Claude binary's smoke test:
            // spawn the pinned runtime and complete one ACP handshake. The
            // model request itself is exercised by the first real turn.
            const smoke = yield* runDshSmokeTest({
              runtime: yield* resolveDshRuntime(effectiveConfig),
              environment: deepSeekEnv,
              dshHome,
              cwd: serverConfig.cwd,
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Crypto.Crypto, cryptoService),
              Effect.provideService(Path.Path, path),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
            );
            if (!smoke.ok) {
              return yield* new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `The DeepSeek Harness smoke test failed: ${smoke.detail}`,
              });
            }
            return;
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
