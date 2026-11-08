/** DeepSeek's snapshot and status probe: Flash models, binary probe, key state. */
import {
  DEEPSEEK_AGENT_MODE_OPTION_ID,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

import { type DeepSeekModelCatalog, scopeDeepSeekModelCatalog } from "./catalog.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV } from "./environment.ts";
import { resolveDeepSeekEngine, type DeepSeekEngine } from "./engine.ts";
import type { DeepSeekSettings } from "../settings.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Agent modes a DeepSeek bot may run in on the DeepSeek Harness (dsh) engine.
 * dsh's own presets live only in its web profile, so the ACP launch patch
 * reproduces the three that make sense for a chat bot as extra rows.
 */
export const DEEPSEEK_DSH_AGENT_MODES = [
  { value: "standard", label: "Standard" },
  { value: "code", label: "Code" },
  { value: "minimal", label: "Minimal" },
] as const;

export type DeepSeekDshAgentMode = (typeof DEEPSEEK_DSH_AGENT_MODES)[number]["value"];

/** The agent mode a session runs when nothing else is chosen. */
export const DEEPSEEK_DEFAULT_AGENT_MODE: DeepSeekDshAgentMode = "standard";

/**
 * What the DeepSeek card says when the key is not set yet. A setup step, not
 * a failure, and it never repeats the card's own "Add your DeepSeek API key"
 * headline: plain words pointing at the key field, never the variable name the
 * field hides.
 */
export const DEEPSEEK_KEY_MISSING_MESSAGE =
  "Set it in this instance's settings. Keys come from platform.deepseek.com.";

/**
 * The D2 seam for the harness engine. The pinned runtime probe lands with the
 * harness adapter in D5; until then a dsh instance reports a warning instead
 * of claiming a runtime it has not checked.
 */
export const DEEPSEEK_DSH_RUNTIME_PENDING_MESSAGE =
  "The DeepSeek Harness runtime check lands with the harness adapter.";

/**
 * The models as the picker sees them. On the dsh engine the Flash model gains
 * one extra control, its agent mode (Standard by default), because the mode is
 * a per-chat launch decision rather than an ACP session mode. On the Claude
 * Code engine the descriptor is absent and a saved value is simply ignored.
 */
function deepSeekModelsFromCatalog(
  catalog: DeepSeekModelCatalog,
  engine: DeepSeekEngine,
): ReadonlyArray<ServerProviderModel> {
  if (engine !== "dsh") return catalog.models.map((entry) => entry.model);
  const agentMode = {
    id: DEEPSEEK_AGENT_MODE_OPTION_ID,
    label: "Agent mode",
    type: "select" as const,
    options: DEEPSEEK_DSH_AGENT_MODES.map((mode) => ({
      id: mode.value,
      label: mode.label,
      ...(mode.value === DEEPSEEK_DEFAULT_AGENT_MODE ? { isDefault: true } : {}),
    })),
  };
  return catalog.models.map((entry) => ({
    ...entry.model,
    capabilities: {
      ...entry.model.capabilities,
      optionDescriptors: [...(entry.model.capabilities?.optionDescriptors ?? []), agentMode],
    },
  }));
}

export const buildInitialDeepSeekProviderSnapshot = Effect.fn(
  "DeepSeekProvider.buildInitialDeepSeekProviderSnapshot",
)(function* (
  settings: DeepSeekSettings,
  catalog: DeepSeekModelCatalog,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = deepSeekModelsFromCatalog(
    scopeDeepSeekModelCatalog(catalog, settings.customModels),
    resolveDeepSeekEngine(settings),
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

const checkDeepSeekDshStatus = (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProviderDraft => {
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
  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth,
        message: DEEPSEEK_KEY_MISSING_MESSAGE,
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
      auth,
      message: DEEPSEEK_DSH_RUNTIME_PENDING_MESSAGE,
    },
  });
};

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
  catalog: DeepSeekModelCatalog,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const scoped = scopeDeepSeekModelCatalog(catalog, settings.customModels);
  const engine = resolveDeepSeekEngine(settings, environment);
  const models = deepSeekModelsFromCatalog(scoped, engine);
  if (engine === "dsh") {
    return checkDeepSeekDshStatus(settings, environment, checkedAt, models);
  }

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
        status: "warning",
        auth,
        message: DEEPSEEK_KEY_MISSING_MESSAGE,
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
