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
import {
  type DeepSeekSettings,
  type ServerProviderAuth,
  type ServerProviderSpend,
  type ServerProviderUsageBalance,
} from "@t3tools/contracts";
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
import {
  deepSeekBalanceReader,
  type DeepSeekBalanceFailureReason,
  type DeepSeekBalanceRead,
} from "../Drivers/DeepSeekBalance.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV } from "../Drivers/DeepSeekEnvironment.ts";

const DEEPSEEK_PRESENTATION = {
  displayName: "DeepSeek",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/** How a failed balance read reads on the usage card: short, ours, never DeepSeek's body. */
const BALANCE_FAILURE_NOTES: Record<DeepSeekBalanceFailureReason, string> = {
  missing_key: "DeepSeek API key is missing.",
  http_error: "DeepSeek would not return the balance for this key.",
  network_error: "DeepSeek could not be reached for the balance.",
  timeout: "DeepSeek did not answer the balance request in time.",
  invalid_response: "DeepSeek returned a balance that could not be read.",
};

/**
 * One balance read as the published contract shape. A failed read keeps the
 * last good numbers (`balance`) and says how old they are through `fetchedAt`,
 * exactly as a kept usage window keeps its own time; the newest attempt's
 * outcome is `status`, with a short message of our wording.
 *
 * `spent` is our own figure from the usage scan, not part of the balance read:
 * it rides here so both balance surfaces (the usage sheet card and the Team
 * card) show it from the same snapshot field, and it is absent when there is
 * nothing to price - never a zero standing in for an unknown.
 */
function toUsageBalance(
  read: DeepSeekBalanceRead,
  checkedAt: string,
  spent: ServerProviderSpend | null,
): ServerProviderUsageBalance {
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
    ...(spent !== null ? { spent } : {}),
    ...(read.status === "failed" ? { message: BALANCE_FAILURE_NOTES[read.reason] } : {}),
  };
}

export interface DeepSeekProviderProbeDependencies {
  /** Tests: stub the balance read. Defaults to the shared, cached reader. */
  readonly readBalance?: (token: string) => Promise<DeepSeekBalanceRead>;
  /**
   * The API-price value of our own DeepSeek transcripts, from the usage scan.
   * The driver wires it to `UsageService.readDeepSeekSpend` for the instance's
   * own home; without it (tests, or a caller with no scan) no spend figure is
   * published rather than a guessed one.
   */
  readonly readSpent?: () => Effect.Effect<ServerProviderSpend | null>;
}

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
  dependencies?: DeepSeekProviderProbeDependencies,
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

  // Read before the binary probe, and carried on every outcome below, so a
  // probe that fails for a CLI reason never blanks a balance the card shows.
  // The reader never rejects by contract; a stub that does still must not take
  // the whole probe down.
  const readBalance = dependencies?.readBalance ?? deepSeekBalanceReader.read;
  const usageBalance =
    token.length === 0
      ? undefined
      : yield* Effect.gen(function* () {
          const read = yield* Effect.tryPromise({
            try: () => readBalance(token),
            catch: () =>
              ({
                status: "failed",
                reason: "network_error",
                lastGood: null,
              }) as DeepSeekBalanceRead,
          }).pipe(
            Effect.orElseSucceed((): DeepSeekBalanceRead => ({
              status: "failed",
              reason: "network_error",
              lastGood: null,
            })),
          );
          // Our own spend figure, independent of the balance read: a failed
          // balance still shows it, and a failed scan (or none wired) shows
          // the balance alone rather than a number we cannot stand behind.
          const readSpent = dependencies?.readSpent;
          const spent =
            readSpent === undefined
              ? null
              : yield* readSpent().pipe(Effect.catchCause(() => Effect.succeed(null)));
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          return toUsageBalance(read, checkedAt, spent);
        });

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
        ...(usageBalance ? { usageBalance } : {}),
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
        ...(usageBalance ? { usageBalance } : {}),
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
        ...(usageBalance ? { usageBalance } : {}),
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
        ...(usageBalance ? { usageBalance } : {}),
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
      ...(usageBalance ? { usageBalance } : {}),
    },
  });
});

export function resolveDeepSeekCatalogForManifest(
  manifest: Parameters<typeof resolveDeepSeekModelCatalog>[0],
): DeepSeekModelCatalog {
  return resolveDeepSeekModelCatalog(manifest);
}
