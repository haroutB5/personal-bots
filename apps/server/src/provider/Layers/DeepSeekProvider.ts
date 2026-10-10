/**
 * DeepSeekProvider — snapshot + status probe for the `deepseek` driver.
 *
 * Deliberately small: unlike Claude there is no subscription/account probe,
 * no slash-command metadata, and no reset-credit flow. The probe checks the
 * shared SDK binary (`--version`) and whether the instance environment
 * carries `ANTHROPIC_AUTH_TOKEN`. Models come from the Flash-only manifest
 * catalog. DeepSeek never reads Anthropic account state.
 *
 * @module provider/Layers/DeepSeekProvider
 */
import { type DeepSeekSettings, type ServerProviderAuth } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  BUNDLED_DEEPSEEK_MODEL_CATALOG,
  type DeepSeekModelCatalog,
  resolveDeepSeekModelCatalog,
  scopeDeepSeekModelCatalog,
} from "../DeepSeekModelCatalog.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV } from "../Drivers/DeepSeekEnvironment.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;

function deepSeekModelsFromCatalog(catalog: DeepSeekModelCatalog) {
  return catalog.models.map((entry) => entry.model);
}

export function buildInitialDeepSeekProviderSnapshot(
  settings: DeepSeekSettings,
  catalog: DeepSeekModelCatalog = BUNDLED_DEEPSEEK_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = deepSeekModelsFromCatalog(
      scopeDeepSeekModelCatalog(catalog, settings.customModels),
    );
    if (!settings.enabled) {
      return buildServerProvider({
        presentation: DEEPSEEK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "DeepSeek is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking DeepSeek availability...",
      },
    });
  });
}

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
  catalog: DeepSeekModelCatalog = BUNDLED_DEEPSEEK_MODEL_CATALOG,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const scoped = scopeDeepSeekModelCatalog(catalog, settings.customModels);
  const models = deepSeekModelsFromCatalog(scoped);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "DeepSeek is disabled in T3 Code settings.",
      },
    });
  }

  const token = environment[DEEPSEEK_AUTH_TOKEN_ENV]?.trim() ?? "";
  const auth: ServerProviderAuth = token
    ? { status: "authenticated", type: "api_key", label: "DeepSeek API key" }
    : { status: "unauthenticated" };

  const binaryPath = settings.binaryPath.trim() || "claude";
  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth,
        message: isCommandMissingCause(error)
          ? "Claude Agent SDK binary (`claude`) is not installed or not on PATH, so DeepSeek sessions cannot start."
          : "Failed to run the agent binary health check for DeepSeek.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth,
        message: "The agent binary timed out during the DeepSeek health check.",
      },
    });
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0) {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "The agent binary is installed but failed to run for DeepSeek.",
      },
    });
  }

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message:
          "DeepSeek API key is missing. Add ANTHROPIC_AUTH_TOKEN as a sensitive environment variable on this DeepSeek instance.",
      },
    });
  }

  return buildServerProvider({
    presentation: DEEPSEEK_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export function resolveDeepSeekCatalogForManifest(
  manifest: Parameters<typeof resolveDeepSeekModelCatalog>[0],
): DeepSeekModelCatalog {
  return resolveDeepSeekModelCatalog(manifest);
}
