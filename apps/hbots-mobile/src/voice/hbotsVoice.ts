import type { VoiceDeadlineKind } from "@hbots/personal-client/conversation/voice/callState";
import { requireOptionalNativeModule } from "expo";

export type NativeCallState = "idle" | "starting" | "live" | "held" | "stopping";

/**
 * The native mic lease ran out. JS names the deadline and decides how the call
 * ends; the native side only knows the mic must close now.
 */
export type NativeDeadlineReason =
  | "deadline_connect"
  | "deadline_quiet"
  | "deadline_waiting_cap"
  | "deadline_reconnect"
  | "deadline_limit";

export type NativeEndReason =
  | NativeDeadlineReason
  | "hung_up"
  | "notification_hangup"
  | "signed_out"
  | "permission_revoked"
  | "focus_lost"
  | "process_recovered"
  | "failed";

export type NativeRoute = "wired" | "bluetooth" | "speaker";

export type NativeCue = "connected" | "incoming" | "mute" | "unmute" | "ended" | "error";

export interface Subscription {
  remove(): void;
}

export interface NativeVoiceEvents {
  micFrame: { readonly pcm: string };
  route: { readonly route: NativeRoute };
  callEnded: { readonly reason: NativeEndReason };
  held: { readonly held: boolean };
  captureFailure: { readonly code: string };
}

/** How the last call ended on a native deadline, read once and then forgotten. */
export interface NativeLastEnd {
  readonly reason: NativeEndReason;
  readonly atElapsedMs: number;
  readonly wallMs: number;
}

export interface HbotsVoiceModule {
  micPermission(): "granted" | "denied";
  openAppSettings(): void;
  takeRecovery(): boolean;
  /** Reads and clears how the last call ended when a native deadline closed it, or null. */
  takeLastEnd(): NativeLastEnd | null;
  /** Keeps the mic open for at most `inMs` more, for this reason. Native enforces it on its own clock. */
  holdMicUntil(kind: VoiceDeadlineKind, inMs: number): void;
  callState(): NativeCallState;
  startCall(botName: string, source: "tap"): Promise<void>;
  startCapture(): Promise<void>;
  setMuted(muted: boolean): void;
  play(base64: string, rate: number): void;
  stopPlayback(): void;
  playSample(base64: string, rate: number): void;
  stopSample(): void;
  cue(kind: NativeCue): void;
  readLevel(source: "mic" | "voice" | "none"): number;
  route(): NativeRoute | null;
  endCall(): void;
  wipe(): void;
  addListener<K extends keyof NativeVoiceEvents>(
    event: K,
    listener: (payload: NativeVoiceEvents[K]) => void,
  ): Subscription;
}

/** Null when the module is not linked (tests, an older APK). Every caller must cope with that. */
export const hbotsVoice: HbotsVoiceModule | null =
  requireOptionalNativeModule<HbotsVoiceModule>("HbotsVoice");
