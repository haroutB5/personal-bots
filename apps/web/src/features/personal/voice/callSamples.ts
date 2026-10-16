/**
 * Playing a voice sample in Settings > Voice calls.
 *
 * Two things decide whether this works at all on an iPhone, and both live here:
 *
 * 1. **The audio context is created and resumed inside the tap.** iOS only
 *    starts audio from a user gesture, and an `await` of any kind loses that
 *    gesture, so `unlock()` must run synchronously in the click handler,
 *    before the sample is fetched. The fetch is deliberately NOT inside it.
 * 2. **One clip at a time.** Tapping a second voice stops the first, and every
 *    source is disconnected when it ends, so a fast tap-tap-tap cannot stack
 *    audio or leak browser resources.
 *
 * The module is pure apart from the injected context factory, so the whole
 * sequence (unlock, fetch, decode, play, stop) is testable without a browser.
 *
 * @module features/personal/voice/callSamples
 */
import type { VoiceCallSampleResult } from "./voiceCallApi";

/** What this module needs from an AudioContext, so a test can stand in for one. */
export interface VoiceSampleAudioContext {
  readonly state: string;
  resume: () => Promise<void> | void;
  decodeAudioData: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
  createBufferSource: () => AudioBufferSourceNode;
  readonly destination: AudioNode;
  close: () => Promise<void> | void;
}

export interface VoiceSampleAudio {
  /** Create or resume the context. Synchronously, in the tap handler. */
  readonly unlock: () => void;
  /** Decode and play these bytes; stops whatever was playing. */
  readonly play: (bytes: Uint8Array) => Promise<void>;
  /** Fired when a clip ends by itself, so the button can leave its playing state. */
  readonly onEnded: (listener: () => void) => void;
  readonly stop: () => void;
  readonly dispose: () => void;
}

/** base64 from the server into the bytes `decodeAudioData` wants. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function createVoiceSampleAudio(
  createContext: () => VoiceSampleAudioContext,
): VoiceSampleAudio {
  let context: VoiceSampleAudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let ended: (() => void) | null = null;

  const stop = () => {
    if (source === null) return;
    try {
      source.onended = null;
      source.stop();
    } catch {
      // Already stopped: nothing to do.
    }
    source.disconnect();
    source = null;
  };

  return {
    unlock: () => {
      context ??= createContext();
      // Not awaited on purpose: this call happens inside the tap, and awaiting
      // anything here is what loses iOS's permission to play.
      void context.resume();
    },
    play: async (bytes) => {
      context ??= createContext();
      await context.resume();
      stop();
      const decoded = await context.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      const next = context.createBufferSource();
      next.buffer = decoded;
      next.connect(context.destination);
      next.onended = () => {
        if (source === next) {
          source = null;
          ended?.();
        }
      };
      source = next;
      next.start();
    },
    onEnded: (listener) => {
      ended = listener;
    },
    stop,
    dispose: () => {
      stop();
      const current = context;
      context = null;
      void current?.close();
    },
  };
}

/** The one place the app builds a real one. */
export const createBrowserVoiceSampleAudio = (): VoiceSampleAudio =>
  createVoiceSampleAudio(() => new AudioContext());

/**
 * One voice's clip from the server. A separate function so the button can be
 * handed a fake in a test without an RPC runtime.
 */
export type FetchVoiceSample = (input: {
  readonly voiceName: string;
}) => Promise<VoiceCallSampleResult>;
