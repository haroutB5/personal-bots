import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { grantedScopes } from "../sessionScopes";

export interface RescueRebootConfig {
  readonly url: string;
  readonly token: string;
}

/**
 * Validates a rescue reboot target. Strictly requires an `https:` URL with a
 * hostname and a non-empty bearer token.
 */
export function parseRescueRebootConfig(value: unknown): RescueRebootConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  const rawUrl = fields["url"];
  const rawToken = fields["token"];
  if (typeof rawUrl !== "string" || typeof rawToken !== "string") return null;

  const token = rawToken.trim();
  if (token.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    return null;
  }
  return { url: parsed.toString(), token };
}

/**
 * Settings > Restart laptop: the owner restarts the computer hosting the bots,
 * for when the server is stuck (1.67.50: a failing disk left every bot
 * unreachable). The server route is `/api/personal/system/reboot`; this file
 * holds everything the row and offline banner decide, so screens only draw it.
 */
export const RESTART_LAPTOP_PATH = "/api/personal/system/reboot";
/** How long the row must be held before the confirm sheet opens. */
export const RESTART_HOLD_MS = 2_000;
/** After asking, when to check whether the server is somehow still up with an error. */
export const RESTART_RECHECK_MS = 15_000;
export const RESTART_REQUEST_TIMEOUT_MS = 15_000;
export const RESTART_PRIMARY_TIMEOUT_MS = 10_000;
export const RESTART_RESCUE_TIMEOUT_MS = 10_000;

export const RESTART_ROW_TITLE = "Restart laptop";
export const RESTART_ROW_HINT = "Hold for 2 seconds to restart the computer hosting your bots";
export const RESTART_BACKUP_READY_HINT = "Backup restart path ready";
export const RESTART_OFFLINE_BUTTON_LABEL = "Restart";
export const RESTART_CONFIRM_TITLE = "Restart the laptop?";
export const RESTART_CONFIRM_BODY =
  "Every bot stops until the laptop is back. Unsaved work in open apps on the laptop is lost.";
export const RESTART_CONFIRM_LABEL = "Restart";
export const RESTART_CANCEL_LABEL = "Cancel";
export const RESTARTING_TEXT =
  "Restarting. The app reconnects when the laptop is back (about 1-2 min).";
export const RESTART_DRY_RUN_TEXT =
  "Dry run: the server logged the restart but the laptop stays on.";
export const RESTART_HOLD_HINT_TEXT = "Hold the row for 2 seconds to restart.";

/** Stable handles for an emulator driver. */
export const RESTART_TEST_IDS = {
  row: "settings-restart-laptop",
  confirmSheet: "restart-laptop-confirm",
  confirm: "restart-laptop-confirm-button",
  cancel: "restart-laptop-cancel-button",
  restarting: "restart-laptop-restarting",
  dryRun: "restart-laptop-dry-run",
  error: "restart-laptop-error",
  backupReadyHint: "restart-laptop-backup-ready",
  offlineRestartButton: "offline-banner-restart-button",
  offlineRestartStatus: "offline-banner-restart-status",
} as const;

export type RestartTransport = "rebootd" | "dbus" | "busctl";

/** Only the owner's phone link carries `environment:maintain`; the server checks it again. */
export function canRestartLaptop(scope: string): boolean {
  return grantedScopes(scope).includes(AuthEnvironmentMaintainScope);
}

/** The hold fill, 0 to 1. */
export function restartHoldProgress(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.min(1, elapsedMs / RESTART_HOLD_MS);
}

export function restartHoldComplete(elapsedMs: number): boolean {
  return restartHoldProgress(elapsedMs) >= 1;
}

export type RestartOutcome =
  | { readonly kind: "restarting"; readonly dryRun: boolean }
  | { readonly kind: "error"; readonly message: string };

/** True when primary failed with network/timeout (null), 5xx, or 409; false for 2xx/401/403/429. */
export function shouldTryRescueReboot(status: number | null): boolean {
  if (status === null) return true;
  if (status >= 500 || status === 409) return true;
  return false;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const serverError = (body: unknown): string | null => {
  const error = record(body)?.["error"];
  return typeof error === "string" && error.trim().length > 0 ? error.trim() : null;
};

/** What the POST's answer means for the row. The server's own error text wins. */
export function restartOutcomeFromResponse(status: number, body: unknown): RestartOutcome {
  const fields = record(body);
  if (status >= 200 && status < 300 && fields?.["ok"] === true) {
    return { kind: "restarting", dryRun: fields["dryRun"] === true };
  }
  const message = serverError(body);
  if (message !== null) return { kind: "error", message };
  if (status === 401) return { kind: "error", message: "Sign in on this phone again." };
  if (status === 403) {
    return { kind: "error", message: "Only the owner's phone can restart the laptop." };
  }
  return { kind: "error", message: `The server could not restart the laptop (HTTP ${status}).` };
}

/** A request that never got an answer. */
export function restartOutcomeFromFailure(cause: unknown): RestartOutcome {
  const aborted =
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "AbortError";
  return {
    kind: "error",
    message: aborted
      ? "The laptop did not answer in time. It may be off the network; restart it by hand."
      : "Couldn't reach the laptop. Check the connection and try again.",
  };
}

export interface RestartStatus {
  readonly canRestart: boolean;
  /** Why logind refuses, when it does. */
  readonly refusal: string | null;
  /** The last restart that was accepted but then failed on the laptop. */
  readonly lastError: string | null;
  readonly dryRun: boolean;
  /** Which server-side reboot transport answered preflight. */
  readonly transport: RestartTransport | null;
  /** Optional out-of-band backup rescue endpoint cached on the phone. */
  readonly rescue: RescueRebootConfig | null;
}

const parseTransport = (value: unknown): RestartTransport | null =>
  value === "rebootd" || value === "dbus" || value === "busctl" ? value : null;

/** The GET answer; null for anything this client does not understand. */
export function parseRestartStatus(status: number, body: unknown): RestartStatus | null {
  const fields = record(body);
  if (status !== 200 || fields === null || fields["ok"] !== true) return null;
  const lastError = fields["lastError"];
  return {
    canRestart: fields["canReboot"] === true,
    refusal: serverError(body),
    lastError: typeof lastError === "string" && lastError.length > 0 ? lastError : null,
    dryRun: fields["dryRun"] === true,
    transport: parseTransport(fields["transport"]),
    rescue: parseRescueRebootConfig(fields["rescue"]),
  };
}

export interface RestartWithRescueDeps {
  readonly postPrimary: () => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly loadRescue: () => Promise<RescueRebootConfig | null>;
  readonly postRescue: (
    config: RescueRebootConfig,
  ) => Promise<{ readonly status: number; readonly body: unknown }>;
}

/**
 * Attempts the primary server reboot first; when that fails with a retriable
 * transport/server/preflight failure (`shouldTryRescueReboot`), automatically
 * falls back to the cached backup rescue endpoint.
 */
export async function performRestartWithRescueFallback(
  deps: RestartWithRescueDeps,
): Promise<RestartOutcome> {
  let primaryStatus: number | null = null;
  let primaryOutcome: RestartOutcome;

  try {
    const primary = await deps.postPrimary();
    primaryStatus = primary.status;
    primaryOutcome = restartOutcomeFromResponse(primary.status, primary.body);
    if (primaryOutcome.kind === "restarting") {
      return primaryOutcome;
    }
  } catch (cause) {
    primaryStatus = null;
    primaryOutcome = restartOutcomeFromFailure(cause);
  }

  if (!shouldTryRescueReboot(primaryStatus)) {
    return primaryOutcome;
  }

  const rescue = await deps.loadRescue();
  if (rescue === null) {
    return primaryOutcome;
  }

  try {
    const rescueResponse = await deps.postRescue(rescue);
    const fields = record(rescueResponse.body);
    if (rescueResponse.status >= 200 && rescueResponse.status < 300 && fields?.["ok"] === true) {
      return { kind: "restarting", dryRun: fields["dryRun"] === true };
    }
    return restartOutcomeFromResponse(rescueResponse.status, rescueResponse.body);
  } catch {
    return primaryOutcome;
  }
}
