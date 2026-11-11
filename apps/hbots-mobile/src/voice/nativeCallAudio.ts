import type {
  CallAudioPort,
  VoiceCue,
  VoiceLevelSource,
} from "@hbots/personal-client/voice/callAudioPort";

import type { HbotsVoiceModule, Subscription } from "./hbotsVoice";

const BYTES_PER_FRAME_SAMPLE = 2;

export interface NativeCallAudio extends CallAudioPort {
  onFrame(listener: (pcm: ArrayBuffer) => void): void;
}

export function decodeBase64Pcm(base64: string): ArrayBuffer {
  const binary = globalThis.atob(base64);
  const length = binary.length - (binary.length % BYTES_PER_FRAME_SAMPLE);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function microphoneError(error: unknown): Error {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
  const message = error instanceof Error ? error.message : "The microphone failed.";
  const failure = new Error(message);
  failure.name =
    code === "ERR_VOICE_NO_PERMISSION" || /not allowed|permission/i.test(message)
      ? "NotAllowedError"
      : "NotReadableError";
  return failure;
}

/**
 * The call engine's audio, backed by the hbots-voice native module. Capture,
 * playback, focus and routing all live in the foreground service; this only
 * forwards, so the engine stays the one place that decides anything.
 */
export function createNativeCallAudio(native: HbotsVoiceModule): NativeCallAudio {
  let frameListener: ((pcm: ArrayBuffer) => void) | null = null;
  let subscription: Subscription | null = null;
  let closed = false;

  const ensureSubscription = () => {
    if (subscription !== null || closed) return;
    subscription = native.addListener("micFrame", (event) => {
      if (frameListener === null) return;
      frameListener(decodeBase64Pcm(event.pcm));
    });
  };

  return {
    onFrame(listener) {
      frameListener = listener;
    },
    play(base64, rate) {
      if (closed) return;
      native.play(base64, rate);
    },
    stopPlayback() {
      if (closed) return;
      native.stopPlayback();
    },
    async startMic() {
      if (closed) return;
      ensureSubscription();
      try {
        await native.startCapture();
      } catch (error) {
        throw microphoneError(error);
      }
    },
    setMuted(muted) {
      if (closed) return;
      native.setMuted(muted);
    },
    readLevel(source: VoiceLevelSource) {
      if (closed) return 0;
      return native.readLevel(source);
    },
    cue(kind: VoiceCue) {
      if (closed) return;
      native.cue(kind);
    },
    close() {
      if (closed) return;
      closed = true;
      frameListener = null;
      subscription?.remove();
      subscription = null;
      native.stopPlayback();
      native.endCall();
    },
  };
}
