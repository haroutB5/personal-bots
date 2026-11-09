/** DeepSeek's snapshot and status probe: Flash models, binary probe, key state. */
import {
  DEEPSEEK_AGENT_MODE_OPTION_ID,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderUsageBalance,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";
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

import {
  type DeepSeekBalanceFailureReason,
  type DeepSeekBalanceRead,
  deepSeekBalanceReader,
} from "./balance.ts";
import { type DeepSeekModelCatalog, scopeDeepSeekModelCatalog } from "./catalog.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV } from "./environment.ts";
import {
  DSH_PINNED_VERSION,
  DSH_RUNTIME_MISSING_MESSAGE,
  defaultDshRuntimeDir,
  dshRuntimeBinJs,
  resolveDeepSeekEngine,
  type DeepSeekEngine,
} from "./engine.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type { DeepSeekSettings } from "../settings.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/** The harness reports its prerelease pin, so this keeps `-rc.3`. */
const DSH_VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)\b/;
const parseDshVersion = (output: string): string | null =>
  output.match(DSH_VERSION_PATTERN)?.[1] ?? null;

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

/** How a failed balance read reads on the usage card: short, ours, never DeepSeek's body. */
const BALANCE_FAILURE_NOTES: Record<DeepSeekBalanceFailureReason, string> = {
  missing_key: "Add your DeepSeek API key to read the balance.",
  auth_error: "DeepSeek did not accept this key, so it would not return the balance.",
  insufficient_balance: "This key works; the DeepSeek account has no credit left.",
  http_error: "DeepSeek would not return the balance for this key.",
  network_error: "DeepSeek could not be reached for the balance.",
  timeout: "DeepSeek did not answer the balance request in time.",
  invalid_response: "DeepSeek returned a balance that could not be read.",
};

/**
 * One balance read as the published contract shape. A failed read keeps the
 * last good numbers (`balance`) and says how old they are through `fetchedAt`;
 * the newest attempt's outcome is `status`, with a short message of our wording.
 */
function toUsageBalance(read: DeepSeekBalanceRead, checkedAt: string): ServerProviderUsageBalance {
  const amounts = read.status === "ready" ? read.amounts : read.lastGood?.amounts;
  const fetchedAtMs = read.status === "ready" ? read.fetchedAtMs : read.lastGood?.fetchedAtMs;
  return {
    checkedAt,
    status: read.status,
    ...(amounts !== undefined && fetchedAtMs !== undefined
      ? {
          balance: {
            currency: amounts.currency,
            totalBalance: amounts.totalBalance,
            grantedBalance: amounts.grantedBalance,
            toppedUpBalance: amounts.toppedUpBalance,
            isAvailable: amounts.isAvailable,
            fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(fetchedAtMs)),
          },
        }
      : {}),
    ...(read.status === "failed"
      ? { message: BALANCE_FAILURE_NOTES[read.reason], failureReason: read.reason }
      : {}),
  };
}

export interface DeepSeekProviderProbeDependencies {
  /** Tests: stub the balance read. Defaults to the shared, cached reader. */
  readonly readBalance?: (token: string) => Promise<DeepSeekBalanceRead>;
  /** Tests: the clock the snapshot stamps. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const readUsageBalance = Effect.fn("readUsageBalance")(function* (
  token: string,
  dependencies: DeepSeekProviderProbeDependencies | undefined,
): Effect.fn.Return<ServerProviderUsageBalance | undefined> {
  if (token.length === 0) return undefined;
  const readBalance = dependencies?.readBalance ?? deepSeekBalanceReader.read;
  const failed = (): DeepSeekBalanceRead => ({
    status: "failed",
    reason: "network_error",
    lastGood: null,
  });
  const read = yield* Effect.tryPromise({ try: () => readBalance(token), catch: failed }).pipe(
    Effect.orElseSucceed(failed),
  );
  const now = dependencies?.now ?? Date.now;
  return toUsageBalance(read, DateTime.formatIso(DateTime.makeUnsafe(now())));
});

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

const checkDeepSeekDshStatus = Effect.fn("DeepSeekProvider.checkDshStatus")(function* (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
  models: ReadonlyArray<ServerProviderModel>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path | FileSystem.FileSystem
> {
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
      enabled: settings.enabled,
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
  const path = yield* Path.Path;
  const configuredRuntime = settings.dshRuntimePath.trim();
  const runtimeDir = path.resolve(
    configuredRuntime.length > 0
      ? expandHomePath(configuredRuntime, NodeOS.homedir())
      : defaultDshRuntimeDir(),
  );
  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      NodeProcess.execPath,
      [dshRuntimeBinJs(runtimeDir), "--version"],
      { env: environment },
    );
    return yield* spawnAndCollect(
      NodeProcess.execPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: DEEPSEEK_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth,
        message: missing
          ? DSH_RUNTIME_MISSING_MESSAGE
          : "Failed to run the DeepSeek Harness runtime check.",
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
        message: "The DeepSeek Harness runtime timed out during the health check.",
      },
    });
  }
  const output = versionResult.success.value;
  const version = parseDshVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0 || version !== DSH_PINNED_VERSION) {
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
          version === null
            ? "The DeepSeek Harness runtime is installed but did not report its version."
            : `The DeepSeek Harness runtime at ${runtimeDir} is ${version}, not the pinned ${DSH_PINNED_VERSION}.`,
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

const probeDeepSeekProviderStatus = Effect.fn("probeDeepSeekProviderStatus")(function* (
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
    return yield* checkDeepSeekDshStatus(settings, environment, checkedAt, models);
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

export const checkDeepSeekProviderStatus = Effect.fn("checkDeepSeekProviderStatus")(function* (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
  catalog: DeepSeekModelCatalog,
  dependencies?: DeepSeekProviderProbeDependencies,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path | FileSystem.FileSystem
> {
  const snapshot = yield* probeDeepSeekProviderStatus(settings, environment, catalog);
  if (!settings.enabled) return snapshot;
  const token = environment[DEEPSEEK_AUTH_TOKEN_ENV]?.trim() ?? "";
  const usageBalance = yield* readUsageBalance(token, dependencies);
  return usageBalance === undefined ? snapshot : { ...snapshot, usageBalance };
});
