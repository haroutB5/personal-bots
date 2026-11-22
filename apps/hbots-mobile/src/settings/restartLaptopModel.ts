import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { grantedScopes } from "../sessionScopes";

/**
 * Settings > Restart laptop: the owner restarts the computer hosting the bots,
 * for when the server is stuck (1.67.50: a failing disk left every bot
 * unreachable). The server route is `/api/personal/system/reboot`; this file
 * holds everything the row decides, so the screen only draws it.
 */
export const RESTART_LAPTOP_PATH = "/api/personal/system/reboot";
/** How long the row must be held before the confirm sheet opens. */
export const RESTART_HOLD_MS = 2_000;
/** After asking, when to check whether the server is somehow still up with an error. */
export const RESTART_RECHECK_MS = 15_000;
export const RESTART_REQUEST_TIMEOUT_MS = 15_000;

export const RESTART_ROW_TITLE = "Restart laptop";
export const RESTART_ROW_HINT = "Hold for 2 seconds to restart the computer hosting your bots";
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
} as const;

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
}

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
  };
}
