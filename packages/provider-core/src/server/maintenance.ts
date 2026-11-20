import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /** undefined defers to npm; null means the installer could not determine the latest version. */
  readonly latestVersion?: string | null;
  /**
   * Deferred until update checks are enabled; `null` falls back to
   * `latestVersion`, then npm.
   */
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  /** Separates installer release channels that share an update command. */
  readonly latestVersionCacheKey?: string;
  readonly compareVersions?: (current: string, latest: string) => number;
  /** Resolved executable path for advisories when no update command is proven. */
  readonly installPath?: string;
  /** Displayed for manual updates; never executed by T3 Code. */
  readonly manualCommand?: string;
  /**
   * Stable versions installed under the tool directory. A release that cannot
   * start reports no version, so a rollback takes the versions to remove from
   * here instead of asking the binary.
   */
  readonly installedVersions?: ReadonlyArray<string>;
}

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** The provider's environment, including its PATH and custom home. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The `latest` alias a targeted mise install must move. Mise installs an
   * older version without moving the alias, and the provider binary path
   * follows that alias.
   */
  readonly latestPath?: string;
  /**
   * In-process updater for T3-managed installations (Antigravity, managed Codex)
   * that download, verify and activate releases directly.
   */
  readonly run?: (
    onProgress: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<ProviderMaintenanceCommandResult>;
  /** Targeted version switch for in-process managed installations (rollback). */
  readonly runTargetVersion?: (
    version: string,
    onProgress: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<ProviderMaintenanceCommandResult>;
}
