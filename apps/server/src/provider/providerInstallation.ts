import {
  AntigravitySettings,
  ProviderDriverKind,
  type ProviderInstallCancelInput,
  type ProviderInstanceId,
  ProviderSetupError,
  type ProviderSetupInput,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { AntigravityInstallation } from "./AntigravityInstallation.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { CatalogInstaller } from "./catalog/installer.ts";
import { ProviderCatalog } from "./catalog/ProviderCatalog.ts";
import { PersonalBotService } from "../personal/PersonalBotService.ts";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const REGISTRY = ProviderDriverKind.make("registry");
const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings);

/** Route instance setup to the environment-owned installer without owning the download. */
export const makeProviderInstallation = Effect.fn("makeProviderInstallation")(function* () {
  const installation = yield* AntigravityInstallation;
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const catalogInstaller = yield* CatalogInstaller;
  const providerCatalog = yield* ProviderCatalog;
  const personalBots = yield* PersonalBotService;

  const readEntries = Effect.fn("ProviderInstallation.readEntries")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "Could not read provider installation settings.",
          }),
      ),
    );
    return deriveProviderInstanceConfigMap(current);
  });

  const requireInstance = Effect.fn("ProviderInstallation.requireInstance")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
    managedOnly = false,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance?.driverKind !== ANTIGRAVITY) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Managed installation is not available for this provider instance.",
      });
    }
    if (!managedOnly) return;
    const entries = yield* readEntries(instanceId, operation);
    const config = yield* decodeAntigravitySettings(entries[instanceId]?.config ?? {}).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "The Antigravity instance configuration is invalid.",
          }),
      ),
    );
    if (config.binaryPath) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail:
          "This instance uses a custom executable. Clear its binary path to manage installation in T3 Code.",
      });
    }
  });

  const failure =
    (instanceId: ProviderInstanceId, defaultOp = "install") =>
    (error: { operation?: string; detail: string; cause?: unknown }) =>
      new ProviderSetupError({
        instanceId,
        operation: error.operation ?? defaultOp,
        detail: error.detail,
      });

  const start = Effect.fn("ProviderInstallation.start")(function* (input: ProviderSetupInput) {
    const entries = yield* readEntries(input.instanceId, "install");
    const entry = entries[input.instanceId];
    if (entry?.driver === REGISTRY) {
      const catalogId = (entry.config as { catalogId?: string } | undefined)?.catalogId;
      if (!catalogId) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "install",
          detail: "Registry instance catalogId not found.",
        });
      }
      const request = yield* providerCatalog.installRequest(catalogId);
      if (!request) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "install",
          detail: `Agent '${catalogId}' was not found in the catalogue.`,
        });
      }
      const state = yield* catalogInstaller
        .start(request)
        .pipe(Effect.mapError(failure(input.instanceId, "install")));
      return { ...state, driver: REGISTRY };
    }
    yield* requireInstance(input.instanceId, "install", true);
    return yield* installation.start.pipe(Effect.mapError(failure(input.instanceId, "install")));
  });

  const cancel = Effect.fn("ProviderInstallation.cancel")(function* (
    input: ProviderInstallCancelInput,
  ) {
    const entries = yield* readEntries(input.instanceId, "cancel-install");
    const entry = entries[input.instanceId];
    if (entry?.driver === REGISTRY) {
      const catalogId = (entry.config as { catalogId?: string } | undefined)?.catalogId;
      if (!catalogId) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "cancel-install",
          detail: "Registry instance catalogId not found.",
        });
      }
      const state = yield* catalogInstaller
        .cancel(catalogId, input.operationId)
        .pipe(Effect.mapError(failure(input.instanceId, "cancel-install")));
      return { ...state, driver: REGISTRY };
    }
    yield* requireInstance(input.instanceId, "cancel-install");
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId, "cancel-install")));
  });

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const entries = yield* readEntries(input.instanceId, "observe-install");
        const entry = entries[input.instanceId];
        if (entry?.driver === REGISTRY) {
          const catalogId = (entry.config as { catalogId?: string } | undefined)?.catalogId;
          if (!catalogId) {
            return Stream.fail(
              new ProviderSetupError({
                instanceId: input.instanceId,
                operation: "observe-install",
                detail: "Registry instance catalogId not found.",
              }),
            );
          }
          return catalogInstaller
            .changes(catalogId)
            .pipe(Stream.map((s) => ({ ...s, driver: REGISTRY })));
        }
        yield* requireInstance(input.instanceId, "observe-install");
        return installation.changes;
      }),
    );

  const remove = Effect.fn("ProviderInstallation.remove")(function* (input: ProviderSetupInput) {
    const entries = yield* readEntries(input.instanceId, "remove-install");
    const entry = entries[input.instanceId];
    if (entry?.driver === REGISTRY) {
      const catalogId = (entry.config as { catalogId?: string } | undefined)?.catalogId;
      if (!catalogId) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "remove-install",
          detail: "Registry instance catalogId not found.",
        });
      }
      // Refuse Remove while any bot's instance uses the agent (Item 10)
      const botList = yield* personalBots.list().pipe(
        Effect.mapError(
          () =>
            new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "remove-install",
              detail: "Could not check which bots use this agent. Try again before removing it.",
            }),
        ),
      );
      const agentInstanceIds = new Set(
        Object.entries(entries)
          .filter(
            ([, candidate]) =>
              candidate.driver === REGISTRY &&
              (candidate.config as { catalogId?: string } | undefined)?.catalogId === catalogId,
          )
          .map(([id]) => id),
      );
      const usingBot = botList.bots.find(
        (b) =>
          agentInstanceIds.has(b.modelSelection.instanceId) ||
          (b.fallback?.modelSelection?.instanceId !== undefined &&
            agentInstanceIds.has(b.fallback.modelSelection.instanceId)) ||
          (b.schedule?.modelSelection?.instanceId !== undefined &&
            agentInstanceIds.has(b.schedule.modelSelection.instanceId)) ||
          (b.fallbackActive?.modelSelection?.instanceId !== undefined &&
            agentInstanceIds.has(b.fallbackActive.modelSelection.instanceId)),
      );
      if (usingBot) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "remove-install",
          detail: `Cannot remove provider: bot '${usingBot.name}' is configured to use it.`,
        });
      }

      yield* catalogInstaller
        .remove(catalogId)
        .pipe(Effect.mapError(failure(input.instanceId, "remove-install")));
      yield* providers.refreshInstance(input.instanceId);
      const state = yield* catalogInstaller.state(catalogId);
      return { ...state, driver: REGISTRY };
    }

    yield* requireInstance(input.instanceId, "remove-install", true);
    const protectedPaths = yield* Effect.forEach(Object.values(entries), (e) => {
      if (!hasBinaryPath(e.config) || !e.config.binaryPath.trim()) {
        return Effect.succeed([]);
      }
      const binaryPath = e.config.binaryPath.trim();
      return resolveCommandPath(binaryPath, {
        env: mergeProviderInstanceEnvironment(e.environment),
      }).pipe(
        Effect.map((resolved) => [binaryPath, resolved]),
        Effect.orElseSucceed(() => [binaryPath]),
      );
    });
    yield* installation
      .remove(protectedPaths.flat())
      .pipe(Effect.mapError(failure(input.instanceId, "remove-install")));
    const allInstances = yield* instances.listInstances;
    yield* Effect.forEach(
      allInstances.filter((instance) => instance.driverKind === ANTIGRAVITY),
      (instance) => providers.refreshInstance(instance.instanceId),
      { discard: true },
    );
    return yield* installation.state;
  });

  return { start, cancel, subscribe, remove };
});
