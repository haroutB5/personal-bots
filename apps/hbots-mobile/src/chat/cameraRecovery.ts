/**
 * How a launch record left over from a camera launch is recovered at app start or after Android
 * recreates the activity. The record names its chat; the draft only appears once that chat's
 * composer mounts, so a fresh record opens its chat and lets the composer claim it.
 */

/** A record older than this is left for the composer that mounts when its chat is opened. */
export const CAMERA_RECOVERY_MS = 10 * 60 * 1000;

/** The native launch record: the chat that asked for the camera and when it opened. */
export interface PendingCameraLaunch {
  readonly owner: string;
  readonly at: number;
}

/** An open chat that can receive a recovered photo. */
export interface RecoveryChat {
  readonly botId: string;
  readonly threadId: string;
}

export type CameraRecoveryDecision =
  | { readonly kind: "none" }
  | { readonly kind: "wait" }
  | { readonly kind: "drop"; readonly threadId: string }
  | { readonly kind: "leave" }
  | { readonly kind: "open"; readonly botId: string; readonly threadId: string };

/**
 * `wait` while the chat list is unknown, `drop` when the owner chat no longer exists, `leave`
 * an old record for the manual recovered path, and `open` a fresh one. The owner is
 * `${environmentId}/${threadId}`, written by the composer that launched the camera.
 */
export function cameraRecoveryDecision(input: {
  readonly launch: PendingCameraLaunch | null;
  readonly environmentId: string;
  readonly now: number;
  readonly chats: ReadonlyArray<RecoveryChat> | null;
}): CameraRecoveryDecision {
  const launch = input.launch;
  if (launch === null) return { kind: "none" };
  const slash = launch.owner.indexOf("/");
  if (slash <= 0 || slash === launch.owner.length - 1) {
    return { kind: "drop", threadId: launch.owner };
  }
  const environmentId = launch.owner.slice(0, slash);
  const threadId = launch.owner.slice(slash + 1);
  if (environmentId !== input.environmentId) return { kind: "drop", threadId };
  if (input.chats === null) return { kind: "wait" };
  const chat = input.chats.find((candidate) => candidate.threadId === threadId);
  if (chat === undefined) return { kind: "drop", threadId };
  if (input.now - launch.at >= CAMERA_RECOVERY_MS) return { kind: "leave" };
  return { kind: "open", botId: chat.botId, threadId };
}
