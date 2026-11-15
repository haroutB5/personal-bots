import type { ComposerNotice } from "./attachSheetModel";

/** How long the system camera gets to leave the app before the in-app camera opens. */
export const CAMERA_OPEN_MS = 1500;

export interface CameraFailure {
  readonly code: string;
  readonly message: string;
}

export type CameraLaunchOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "rejected"; readonly failure: CameraFailure }
  | { readonly kind: "stalled" };

export type CameraLaunchDecision =
  | { readonly kind: "accept" }
  | { readonly kind: "fallback"; readonly reason: string }
  | { readonly kind: "stop" };

/**
 * A rejected or stalled system camera means Android's activity result launcher is stuck. The
 * in-app CameraView still works, so it is the recovery path. A cancel is the user backing out.
 */
export function cameraLaunchDecision(outcome: CameraLaunchOutcome): CameraLaunchDecision {
  switch (outcome.kind) {
    case "succeeded":
      return { kind: "accept" };
    case "cancelled":
      return { kind: "stop" };
    case "rejected":
      return { kind: "fallback", reason: `System camera failed (${outcome.failure.code}).` };
    case "stalled":
      return { kind: "fallback", reason: "System camera did not open." };
  }
}

/** Expo errors carry a code; anything else is named unknown so the notice still names a cause. */
export function cameraFailure(error: unknown): CameraFailure {
  if (typeof error === "object" && error !== null) {
    const code =
      "code" in error && typeof error.code === "string" && error.code.length > 0
        ? error.code
        : "unknown";
    const message =
      "message" in error && typeof error.message === "string" ? error.message : String(error);
    return { code, message };
  }
  return { code: "unknown", message: String(error) };
}

/** The unregistered launcher rejection stays broken until the app process restarts. */
export function isStuckLauncherFailure(failure: CameraFailure): boolean {
  const text = `${failure.code} ${failure.message}`.toLowerCase();
  return text.includes("unregistered") || text.includes("activityresultlauncher");
}

export function cameraLaunchNotice(failure: CameraFailure): ComposerNotice {
  return { message: `Couldn't open the camera (${failure.code}).`, openSettings: false };
}

export function photoLaunchNotice(failure: CameraFailure): ComposerNotice {
  return {
    message: `Couldn't open the photo picker (${failure.code}). Close and reopen hbots to fix this.`,
    openSettings: false,
  };
}
