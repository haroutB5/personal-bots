import { requireOptionalNativeModule } from "expo";

import type { PendingCameraLaunch } from "./cameraRecovery";

/** A native claim. A photo always names the chat that launched it, and a claim is used once. */
export type CameraClaim =
  | { readonly status: "photo"; readonly uri: string; readonly bytes: number }
  | { readonly status: "empty" }
  | { readonly status: "other"; readonly owner: string };

interface HbotsCameraNative {
  /** Opens the system camera for this chat. True when it saved a photo, false when backed out. */
  launch(owner: string): Promise<boolean>;
  /** The photo this chat launched, once; null when no launch is recorded. */
  claim(owner: string): Promise<CameraClaim | null>;
  /** The launch still waiting for a composer, without consuming it. */
  pending(): Promise<PendingCameraLaunch | null>;
  /** Drops this chat's launch and its file once its chat no longer exists. */
  discard(owner: string): Promise<void>;
  /** Length, picture size and a still for the composer chip; null when Android cannot read it. */
  videoInfo?(uri: string): Promise<VideoInfo | null>;
}

export interface VideoInfo {
  readonly durationMs: number | null;
  readonly width: number;
  readonly height: number;
  readonly thumbnailUri: string | null;
}

/** Null on a build without the helper or for a file Android cannot read as a video. */
export async function readVideoInfo(uri: string): Promise<VideoInfo | null> {
  try {
    return (await native?.videoInfo?.(uri)) ?? null;
  } catch {
    return null;
  }
}

const native = requireOptionalNativeModule<HbotsCameraNative>("HbotsCamera");

/**
 * The system camera's own launch, with EXTRA_OUTPUT in a file this app owns. The launch record
 * is written before the camera opens, so the composer that mounts next still knows the photo's
 * chat after Android destroys the activity or kills the process.
 */
export const HbotsCamera: HbotsCameraNative = {
  launch: (owner) => {
    if (native === null) return Promise.reject(new Error("HbotsCamera module is missing"));
    return native.launch(owner);
  },
  claim: (owner) => (native === null ? Promise.resolve(null) : native.claim(owner)),
  pending: async () => (native === null ? null : native.pending()),
  discard: async (owner) => {
    if (native !== null) await native.discard(owner);
  },
};
