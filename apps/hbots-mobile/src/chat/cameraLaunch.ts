import type { ComposerNotice } from "./attachSheetModel";

/** How long the system camera gets to leave the app before the in-app camera opens. */
export const CAMERA_OPEN_MS = 1500;

/** A capture at or below this mean luma is an all-black frame, not a photo. */
export const BLACK_PHOTO_LUMA = 0.005;

export interface CameraFailure {
  readonly code: string;
  readonly message: string;
}

/** The outcomes the system camera's own activity result can produce. */
export type CameraLaunchSettlement =
  | { readonly kind: "succeeded" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "rejected"; readonly failure: CameraFailure };

/**
 * What ended the launch watch. A timeout is only a stall when the launch was still pending: a
 * launch that settled first can never become one.
 */
export type CameraLaunchOutcome =
  | CameraLaunchSettlement
  | { readonly kind: "timeout"; readonly launchSettled: boolean };

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
    case "timeout":
      return outcome.launchSettled
        ? { kind: "stop" }
        : { kind: "fallback", reason: "System camera did not open." };
  }
}

export interface CameraLaunchWatch {
  /** Settles once: the launch's own outcome, or a timeout after enough foreground time. */
  readonly outcome: Promise<CameraLaunchOutcome>;
  /** The launch's result or rejection arrived. A later timeout cannot change it. */
  readonly settle: (settlement: CameraLaunchSettlement) => void;
  /** The app left the foreground, so the camera took the screen; the wait stops for good. */
  readonly background: () => void;
  /** The composer is gone; drop the timer. */
  readonly close: () => void;
}

/**
 * Watches one system camera launch. The 1500 ms counts only while the app stays in the
 * foreground: backgrounding means the camera took the screen, so the wait is cancelled and a
 * resume never restarts it. A launch that settles first resolves with its own outcome.
 */
export function watchCameraLaunch(input: {
  readonly stallMs: number;
  readonly isForeground: () => boolean;
}): CameraLaunchWatch {
  let resolveOutcome!: (outcome: CameraLaunchOutcome) => void;
  const outcome = new Promise<CameraLaunchOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const stop = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const settleOnce = (value: CameraLaunchOutcome) => {
    if (done) return;
    done = true;
    stop();
    resolveOutcome(value);
  };
  timer = setTimeout(() => {
    timer = null;
    if (done || !input.isForeground()) return;
    settleOnce({ kind: "timeout", launchSettled: false });
  }, input.stallMs);
  return {
    outcome,
    settle: settleOnce,
    background: stop,
    close: () => {
      done = true;
      stop();
    },
  };
}

/** One camera launch at a time, so the chat that launched it owns the recovered photo. */
export function cameraLaunchKey(environmentId: string): string {
  return `t3code:camera-launch:v1:${environmentId}`;
}

/**
 * A pending system-camera photo belongs to the chat that launched the camera. Without a
 * recorded chat the first composer to mount recovers it, as before the marker existed.
 */
export function pendingLaunchOwner(
  pendingThreadId: string | null,
  threadId: string,
): "claim" | "skip" {
  return pendingThreadId === null || pendingThreadId === threadId ? "claim" : "skip";
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

/** A capture the camera saved as a black frame must not land as a draft silently. */
export function isBlackPhoto(meanLuma: number | null): boolean {
  return meanLuma !== null && meanLuma <= BLACK_PHOTO_LUMA;
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
