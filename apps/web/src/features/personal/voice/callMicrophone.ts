/**
 * The microphone request that must happen inside the tap handler.
 *
 * iOS only lets a page make sound from a tap, and WebKit only honours
 * `getUserMedia` while the user's gesture is still being handled. The call's
 * engine and its audio are loaded lazily, so `startMic()` runs after the lazy
 * chunks and after the server has minted the call's pass; asking for the
 * microphone there is refused on the spot with NotAllowedError and no prompt,
 * which is what every call did on the iPhone on 16 Oct 2026 (1.66.55).
 *
 * The tap handler therefore calls `requestMicrophone()` itself and hands the
 * promise down. This module holds that function and nothing else: it has no
 * imports, so pulling it into the chat's startup path costs the call button
 * nothing (the same reason `callAudioContext.ts` exists).
 *
 * @module features/personal/voice/callMicrophone
 */

/** The microphone constraints; echo cancellation keeps the voice from hearing itself. */
export function micConstraints(echo: boolean): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: echo,
      noiseSuppression: echo,
      autoGainControl: echo,
      channelCount: 1,
    },
  };
}

/** Every track off. Safe to call twice: stopping a stopped track does nothing. */
export function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * A microphone request the tap handler made itself, before anything awaited.
 *
 * The caller keeps this object for the whole call: `stop()` is what guarantees
 * that a stream arriving after the call is over (the permission prompt was
 * still up, or the pass failed first) is stopped the moment it lands, instead
 * of leaving a live microphone behind a closed screen.
 */
export interface MicrophoneRequest {
  /** The browser's own answer; rejects with its own error (e.g. NotAllowedError). */
  readonly stream: Promise<MediaStream>;
  /** Stops the tracks whenever they arrive. Idempotent. */
  stop(): void;
}

/**
 * Asks for the microphone and keeps the promise. Call it straight from the tap
 * handler: a `requestMicrophone()` that runs after an `await` fails without
 * ever showing the permission prompt.
 */
export function requestMicrophone(
  input: {
    readonly echoCancellation?: boolean;
  } = {},
): MicrophoneRequest {
  const echo = input.echoCancellation ?? true;
  let stream: Promise<MediaStream>;
  try {
    const media = navigator.mediaDevices;
    if (media === undefined || typeof media.getUserMedia !== "function") {
      throw new Error("This browser has no microphone access.");
    }
    stream = media.getUserMedia(micConstraints(echo));
  } catch (error) {
    stream = Promise.reject(
      error instanceof Error ? error : new Error("This browser has no microphone access."),
    );
  }
  let stopped = false;
  /** The stream, once the browser has handed it over. */
  let arrived: MediaStream | null = null;
  // The rejection is handled here as well as by `startMic`, so a call that is
  // over before anything awaits it cannot surface as an unhandled rejection.
  void stream.then(
    (pending) => {
      arrived = pending;
      if (stopped) stopStreamTracks(pending);
    },
    () => undefined,
  );
  return {
    stream,
    stop() {
      // Idempotent, and it covers both orders: a stream that lands after the
      // call is over, and one that landed before anything could use it.
      if (stopped) return;
      stopped = true;
      if (arrived !== null) stopStreamTracks(arrived);
    },
  };
}
