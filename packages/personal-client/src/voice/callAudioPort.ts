/**
 * What the call engine needs from audio. Narrow on purpose: the web implements
 * it with Web Audio, the phone with the hbots-voice native module, and a test
 * with a stub that records what it was asked to do.
 *
 * @module voice/callAudioPort
 */

import type { VoiceDeadlineKind } from "../conversation/voice/callState.ts";

/** Where the ring's level comes from. */
export type VoiceLevelSource = "mic" | "voice" | "none";

export type VoiceCue = "connected" | "incoming" | "mute" | "unmute" | "ended" | "error";

export interface CallAudioPort {
  /** Plays one PCM chunk from Gemini. */
  play(base64: string, rate: number): void;
  /** Drops everything queued (an interruption). */
  stopPlayback(): void;
  /** Starts (or restarts) the microphone; resolves once frames are flowing. */
  startMic(): Promise<void>;
  /** Mic on or off without a restart. */
  setMuted(muted: boolean): void;
  /** RMS of the active stream, 0 to 1; read from the screen's rAF loop. */
  readLevel(source: VoiceLevelSource): number;
  /**
   * Tells the audio side to keep the microphone open for at most `inMs` more
   * milliseconds, for this reason. The phone's native module enforces it on its
   * own clock, so a call whose JS timers are frozen in the background still
   * lets the mic go. The web has no such need and leaves it out.
   */
  holdMicUntil?(kind: VoiceDeadlineKind, inMs: number): void;
  /** One short cue tone. */
  cue(kind: VoiceCue): void;
  /** Everything down: tracks stopped, sockets of sound closed. */
  close(): void;
}
