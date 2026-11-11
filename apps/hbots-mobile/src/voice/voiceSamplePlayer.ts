import { wavToSamplePcm } from "./sampleWav";

export interface VoiceSampleState {
  readonly playingVoice: string | null;
  readonly loadingVoice: string | null;
  readonly problem: { readonly voiceName: string; readonly message: string } | null;
}

export interface SampleSink {
  playSample(base64: string, rate: number): void;
  stopSample(): void;
}

export type FetchSample = (voiceName: string) => Promise<{ readonly base64: string } | null>;

export interface VoiceSamplePlayer {
  readonly state: () => VoiceSampleState;
  readonly subscribe: (listener: (state: VoiceSampleState) => void) => () => void;
  readonly toggle: (voiceName: string) => void;
  readonly stop: () => void;
  readonly dispose: () => void;
}

const IDLE: VoiceSampleState = { playingVoice: null, loadingVoice: null, problem: null };
export const SAMPLE_FAILED = "Could not play that sample.";

export function voiceSampleProblemLine(state: VoiceSampleState, voiceName: string): string | null {
  return state.problem !== null && state.problem.voiceName === voiceName
    ? state.problem.message
    : null;
}

/**
 * One player for the whole voice sheet. A generation token is bumped by Stop,
 * a second voice and dispose, so a clip fetched after any of them is dropped
 * instead of starting late.
 */
export function createVoiceSamplePlayer(options: {
  readonly sink: SampleSink | null;
  readonly fetchSample: FetchSample;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}): VoiceSamplePlayer {
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<(state: VoiceSampleState) => void>();
  let current = IDLE;
  let generation = 0;
  let timer: unknown = null;

  const emit = (next: VoiceSampleState) => {
    current = next;
    for (const listener of listeners) listener(next);
  };

  const cancel = () => {
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    options.sink?.stopSample();
  };

  const fail = (voiceName: string) =>
    emit({
      playingVoice: null,
      loadingVoice: null,
      problem: { voiceName, message: SAMPLE_FAILED },
    });

  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle: (voiceName) => {
      const wasPlaying = current.playingVoice === voiceName || current.loadingVoice === voiceName;
      cancel();
      if (wasPlaying) {
        emit(IDLE);
        return;
      }
      if (options.sink === null) {
        fail(voiceName);
        return;
      }
      const sink = options.sink;
      const token = generation;
      emit({ playingVoice: null, loadingVoice: voiceName, problem: null });
      void options.fetchSample(voiceName).then(
        (sample) => {
          if (token !== generation) return;
          const pcm = sample === null ? null : wavToSamplePcm(sample.base64);
          if (pcm === null) {
            fail(voiceName);
            return;
          }
          sink.playSample(pcm.base64, pcm.rate);
          emit({ playingVoice: voiceName, loadingVoice: null, problem: null });
          timer = setTimer(() => {
            if (token === generation) emit(IDLE);
          }, pcm.durationMs + 150);
        },
        () => {
          if (token === generation) fail(voiceName);
        },
      );
    },
    stop: () => {
      cancel();
      emit(IDLE);
    },
    dispose: () => {
      cancel();
      listeners.clear();
      current = IDLE;
    },
  };
}
