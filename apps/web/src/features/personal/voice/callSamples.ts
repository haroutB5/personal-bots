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
  /**
   * Decode and play these bytes; stops whatever was playing. `isCurrent` is
   * asked after the context resumes and again after the decode, so a clip whose
   * request was cancelled in the meantime never starts: decoding takes long
   * enough for the owner to have pressed Stop or closed the sheet, and audio
   * after either is the bug Astra re-check R6 names.
   */
  readonly play: (bytes: Uint8Array, isCurrent?: () => boolean) => Promise<void>;
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
    play: async (bytes, isCurrent) => {
      context ??= createContext();
      await context.resume();
      // The tap may have been cancelled during the resume (another voice, Stop,
      // the sheet closing): nothing should start from here.
      if (isCurrent !== undefined && !isCurrent()) return;
      stop();
      const decoded = await context.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      // Decoding is the slow part, so this is the second, more important check:
      // `next.start()` after a Stop or after unmount would play with no way to
      // stop it (Astra re-check R6).
      if (isCurrent !== undefined && !isCurrent()) return;
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

/** What the sheet shows: which voice is playing, and the last failure. */
export interface VoiceSamplePlayerState {
  readonly playingVoice: string | null;
  /**
   * The voice whose clip failed, so the line sits under that button and not
   * under all of them.
   */
  readonly problem: { readonly voiceName: string; readonly message: string } | null;
}

/** How the sample UI reads the line under a failed button. */
export const voiceSampleProblemLine = (
  state: VoiceSamplePlayerState,
  voiceName: string,
): string | null =>
  state.problem !== null && state.problem.voiceName === voiceName ? state.problem.message : null;

/**
 * One player for the whole Voice sheet.
 *
 * Astra re-check R6: a player per button let two voices play at once, and a
 * fetch or a decode that finished after Stop (or after the sheet closed) still
 * started audio. This owns the single audio context, the single clip in flight
 * and a generation token that every async step checks: Stop, picking another
 * voice and unmount all bump the token, so a late fetch or decode is dropped.
 *
 * `toggle` must be called synchronously from the tap: it unlocks the context
 * itself, because iOS only starts audio from a user gesture and an `await`
 * loses that gesture.
 */
export interface VoiceSamplePlayer {
  readonly toggle: (voiceName: string) => void;
  readonly stop: () => void;
  readonly dispose: () => void;
  readonly state: () => VoiceSamplePlayerState;
  readonly subscribe: (listener: (state: VoiceSamplePlayerState) => void) => () => void;
}

export function createVoiceSamplePlayer(options: {
  readonly createAudio: () => VoiceSampleAudio;
  readonly fetchSample: FetchVoiceSample;
}): VoiceSamplePlayer {
  let audio: VoiceSampleAudio | null = null;
  /** Bumped by every Stop, switch, second tap and unmount. */
  let generation = 0;
  let current: VoiceSamplePlayerState = { playingVoice: null, problem: null };
  const listeners = new Set<(state: VoiceSamplePlayerState) => void>();
  const emit = (next: VoiceSamplePlayerState) => {
    current = next;
    for (const listener of listeners) listener(next);
  };

  const sampleFailed = () => "Sample unavailable right now";
  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggle: (voiceName) => {
      const player = (audio ??= options.createAudio());
      // Inside the tap, before anything asynchronous.
      player.unlock();
      const wasPlaying = current.playingVoice;
      generation += 1;
      const token = generation;
      // One clip at a time, whatever was playing.
      player.stop();
      if (wasPlaying === voiceName) {
        emit({ playingVoice: null, problem: null });
        return;
      }
      emit({ playingVoice: voiceName, problem: null });
      player.onEnded(() => {
        if (generation === token) emit({ playingVoice: null, problem: null });
      });
      void options
        .fetchSample({ voiceName })
        .then((sample) => {
          if (generation !== token) return undefined;
          return player.play(base64ToBytes(sample.base64), () => generation === token);
        })
        .catch(() => {
          if (generation !== token) return;
          emit({ playingVoice: null, problem: { voiceName, message: sampleFailed() } });
        });
    },
    stop: () => {
      generation += 1;
      audio?.stop();
      emit({ playingVoice: null, problem: null });
    },
    dispose: () => {
      generation += 1;
      const player = audio;
      audio = null;
      player?.dispose();
      listeners.clear();
      current = { playingVoice: null, problem: null };
    },
  };
}

/**
 * One voice's clip from the server. A separate function so the button can be
 * handed a fake in a test without an RPC runtime.
 */
export type FetchVoiceSample = (input: {
  readonly voiceName: string;
}) => Promise<VoiceCallSampleResult>;
