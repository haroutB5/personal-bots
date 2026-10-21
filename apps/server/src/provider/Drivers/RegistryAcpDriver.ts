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
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { defaultIconUrlFor, isOpenSourceLicense } from "../catalog/entries.ts";
import { CatalogInstaller } from "../catalog/installer.ts";
import { resolveNodePath } from "../catalog/launch.ts";
import { ProviderCatalog } from "../catalog/ProviderCatalog.ts";
import {
  makeRegistryAuthMemory,
  signInSnapshotMessage,
  signInTurnMessage,
} from "../catalog/registryAuth.ts";
import {
  probeRegistryAgent,
  smokeTestRegistryAgent,
  type RegistryProbeResult,
} from "../catalog/registryProbe.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeRegistryAcpAdapter } from "../Layers/RegistryAcpAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const DRIVER_KIND = ProviderDriverKind.make("registry");

export const RegistryAcpConfig = Schema.Struct({
  catalogId: Schema.String,
});
export type RegistryAcpConfig = typeof RegistryAcpConfig.Type;

/** The check that starts the agent runs at boot, after an install or Remove, and on "Check again", about hourly while someone looks. */
const PROBE_INTERVAL = "1 hour";

export type RegistryAcpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettingsService
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
  create: ({ instanceId, displayName, accentColor, enabled, config, environment }) =>
    Effect.gen(function* () {
      const installer = yield* CatalogInstaller;
      const catalog = yield* ProviderCatalog;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalogId = config.catalogId;

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const nodePath = yield* resolveNodePath(process.env).pipe(Effect.orElseSucceed(() => null));
      const extraEnv = Object.fromEntries(
        (environment ?? []).map((entry) => [entry.name, entry.value]),
      );
      const launch = {
        installer,
        catalogId,
        nodePath,
        hostEnvironment: process.env,
        extraEnv,
      } as const;
      const withHost = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | ChildProcessSpawner.ChildProcessSpawner
          | Crypto.Crypto
          | FileSystem.FileSystem
          | Path.Path
        >,
      ) =>
        effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );

      const entryName = catalog.list({}).pipe(
        Effect.map(
          (res) => res.entries.find((candidate) => candidate.catalogId === catalogId)?.name,
        ),
        Effect.orElseSucceed(() => undefined),
      );
      const nameOf = entryName.pipe(Effect.map((name) => displayName || name || catalogId));

      // What the last health check found, and what sign-in looks like for this agent.
      const authMemory = yield* makeRegistryAuthMemory();
      const probeRef = yield* Ref.make<{
        readonly result: RegistryProbeResult;
        readonly at: string;
      } | null>(null);
      // Kept across a failed check, so a hiccup does not empty the model list.
      const modelsRef = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);

      const compose = Effect.gen(function* () {
        const installState = yield* installer.state(catalogId);
        const installed = yield* installer.resolve(catalogId);
        const entries = yield* catalog.list({}).pipe(
          Effect.map((res) => res.entries),
          Effect.orElseSucceed(() => []),
        );
        const entry = entries.find((e) => e.catalogId === catalogId);
        const nowIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const name = displayName || entry?.name || catalogId;
        const probed = yield* Ref.get(probeRef);
        const models = yield* Ref.get(modelsRef);
        const auth = yield* SubscriptionRef.get(authMemory.state);

        const isInstalled = installed !== null;
        const version =
          installed?.version ?? (isInstalled && installState.version ? installState.version : null);
        const previousVersion = installed?.previousVersion ?? installState.previousVersion ?? null;

        const signInNeeded =
          auth.methods.length > 0 && auth.verdict !== "signedIn"
            ? signInSnapshotMessage(name, auth.methods)
            : null;
        const verdict: Pick<ServerProvider, "status" | "auth"> & { message?: string } = !enabled
          ? { status: "disabled", auth: { status: "unknown" } }
          : !isInstalled || probed?.result.kind === "notInstalled"
            ? {
                status: "warning",
                auth: { status: "unknown" },
                message: `${name} is not installed yet.`,
              }
            : probed === null
              ? { status: "warning", auth: { status: "unknown" }, message: `Checking ${name}.` }
              : probed.result.kind === "failed"
                ? { status: "error", auth: { status: "unknown" }, message: probed.result.message }
                : probed.result.kind === "authRequired" || signInNeeded !== null
                  ? {
                      status: "warning",
                      auth: { status: "unauthenticated" },
                      message: signInNeeded ?? signInSnapshotMessage(name, auth.methods),
                    }
                  : auth.methods.length > 0
                    ? { status: "ready", auth: { status: "authenticated" } }
                    : { status: "ready", auth: { status: "unknown" } };

        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: name,
          ...(accentColor ? { accentColor } : {}),
          continuation: {
            groupKey: continuationIdentity.continuationKey,
          },
          enabled,
          installed: isInstalled,
          version,
          previousVersion,
          status: verdict.status,
          auth: verdict.auth,
          ...(verdict.message ? { message: verdict.message } : {}),
          checkedAt: probed?.at ?? nowIso,
          models,
          slashCommands: [],
          skills: [],
          setup: {
            canAuthenticate: false,
            canInstall: true,
            canRemove: true,
            canTest: true,
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

      // Starts the agent (initialize and a new session, no prompt). Only the
      // managed loop calls it: at boot, after an install or Remove, on
      // "Check again", and hourly while someone is looking.
      const checkProvider = Effect.gen(function* () {
        if (enabled) {
          const result = yield* withHost(probeRegistryAgent(launch));
          const at = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          if (result.kind === "ok") {
            yield* Ref.set(modelsRef, result.models);
            yield* authMemory.setMethods(result.authMethods);
          } else if (result.kind === "authRequired") {
            yield* authMemory.setMethods(result.authMethods);
            yield* authMemory.markNeeded;
          } else if (result.kind === "failed") {
            yield* authMemory.setMethods(result.authMethods);
          } else {
            yield* Ref.set(modelsRef, []);
          }
          yield* Ref.set(probeRef, { result, at });
        }
        return yield* compose;
      });

      const managed = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          ),
        getSettings: Effect.succeed({ enabled }),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => compose,
        checkProvider,
        refreshInterval: PROBE_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not prepare the registry provider status.",
              cause,
            }),
        ),
      );

      // A new, replaced or removed version changes what the agent offers.
      yield* installer.changes(catalogId).pipe(
        Stream.map((state) => state.installedVersion),
        Stream.changes,
        Stream.drop(1),
        Stream.runForEach(() => managed.refresh),
        Effect.forkScoped,
      );

      const snapshot: ServerProviderShape = {
        ...managed,
        getSnapshot: compose,
        streamChanges: Stream.concat(
          Stream.fromEffect(compose),
          Stream.mergeAll(
            [
              managed.streamChanges.pipe(Stream.map(() => undefined)),
              installer.changes(catalogId).pipe(Stream.map(() => undefined)),
              SubscriptionRef.changes(authMemory.state).pipe(Stream.map(() => undefined)),
            ],
            { concurrency: "unbounded" },
          ).pipe(Stream.mapEffect(() => compose)),
        ),
      };

      const smokeTest: NonNullable<ProviderInstance["smokeTest"]> = ({ model }) =>
        Effect.gen(function* () {
          const name = yield* nameOf;
          const outcome = yield* withHost(smokeTestRegistryAgent({ ...launch, model }));
          if (outcome.kind === "passed") {
            yield* authMemory.setMethods(outcome.authMethods);
            yield* authMemory.markSignedIn;
            return;
          }
          if (outcome.kind === "silent") {
            yield* authMemory.setMethods(outcome.authMethods);
            if (outcome.authMethods.length > 0) {
              yield* authMemory.markNeeded;
              return yield* new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: signInTurnMessage(name, outcome.authMethods),
              });
            }
            return yield* new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `${name} did not answer. Check that it starts, then try again.`,
            });
          }
          return yield* new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: outcome.message,
          });
        });

      const textGeneration: TextGeneration.TextGeneration["Service"] = {
        generateCommitMessage: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generate",
              detail: "Text generation is not supported for registry providers.",
            }),
          ),
        generatePrContent: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generate",
              detail: "Text generation is not supported for registry providers.",
            }),
          ),
        generateThreadTitle: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generate",
              detail: "Text generation is not supported for registry providers.",
            }),
          ),
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generate",
              detail: "Text generation is not supported for registry providers.",
            }),
          ),
      };

      const adapter = yield* makeRegistryAcpAdapter({
        instanceId,
        catalogId,
        nodePath,
        hostEnvironment: process.env,
        extraEnv,
        displayName: yield* nameOf,
        auth: authMemory,
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
        smokeTest,
      } satisfies ProviderInstance;
    }),
};
