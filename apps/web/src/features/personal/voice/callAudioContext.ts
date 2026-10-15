/**
 * The one function that must run synchronously inside a tap.
 *
 * iOS only lets a page make sound if the AudioContext is created (and resumed)
 * in the same task as the user's gesture. Every entry into a call therefore
 * calls this before it awaits anything: the composer's call button, the ⋯ menu
 * item and "Call back" on a finished call card.
 *
 * It lives in its own module on purpose. `callAudio.ts` pulls in the worklet
 * URL and the whole playback graph, so importing it eagerly to reach this
 * function would put the audio layer in the chat bundle; this file is a few
 * hundred bytes and has no imports.
 *
 * @module features/personal/voice/callAudioContext
 */

type AudioContextConstructor = typeof AudioContext;

/** The AudioContext constructor this browser has, or null. */
export function callAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Builds the call's AudioContext. Call it directly in the tap handler, before
 * the first `await`; a null answer means the device has no Web Audio and the
 * call can still run, just silently.
 */
export function createCallAudioContext(): AudioContext | null {
  const Ctor = callAudioContextConstructor();
  if (Ctor === null) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}
