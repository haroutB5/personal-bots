/**
 * The call's audio: the microphone, the voice coming back from Gemini, the
 * level the ring moves with, and the four sound cues. No React and no socket,
 * so the screen only ever reads one number per frame and writes it to a CSS
 * variable.
 *
 * iPhone realities this module carries (spec 7):
 * - iOS only starts audio from a tap. `createCallAudio()` therefore builds the
 *   AudioContext synchronously in the tap handler, before any lazy import
 *   resolves, and `startMic()` resumes it.
 * - `navigator.audioSession.type = "play-and-record"` is the call category.
 *   Guarded: the API is recent and absent on desktop Safari.
 * - Mute disables the track instead of stopping it, so unmute is instant.
 * - Output is plain Web Audio (spike setup A, chosen by Harout on 15 Oct after
 *   A, B, C and D all played through the bottom speaker), so there is no
 *   speaker toggle and no `<audio>` element.
 *
 * @module features/personal/voice/callAudio
 */
import workletUrl from "./pcm16kCapture.js?url";

/** Where the ring's level comes from. */
export type VoiceLevelSource = "mic" | "voice" | "none";

export type VoiceCue = "connected" | "incoming" | "mute" | "unmute" | "ended" | "error";

/**
 * What the engine needs from audio. Narrow on purpose: a test drives the call
 * with a stub that just records what it was asked to do.
 */
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
  /** One short Web Audio tone (spec 10). */
  cue(kind: VoiceCue): void;
  /** Everything down: tracks stopped, sockets of sound closed. */
  close(): void;
}

export interface CallAudio extends CallAudioPort {
  /** The context's own rate, for diagnostics and tests. */
  readonly sampleRate: number;
}

type AudioContextLike = AudioContext;

function createContext(): AudioContextLike {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) throw new Error("This browser has no Web Audio.");
  return new Ctor();
}

/** Level smoothing: fast attack, slower release (spec 3.3). */
const ATTACK = 0.45;
const RELEASE = 0.12;

function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index]!;
    sum += value * value;
  }
  return Math.sqrt(sum / buffer.length);
}

/** Cue tones: Web Audio oscillators, no files (spec 10). */
function playCue(context: AudioContext, kind: VoiceCue): void {
  const tone = (frequency: number, ms: number, type: OscillatorType = "sine") => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    const start = context.currentTime;
    const end = start + ms / 1_000;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.01);
    gain.gain.setValueAtTime(0.15, Math.max(start + 0.01, end - 0.01));
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.01);
  };
  switch (kind) {
    case "connected":
      tone(660, 90);
      setTimeout(() => tone(880, 90), 120);
      return;
    case "incoming": {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = 740;
      const start = context.currentTime;
      gain.gain.setValueAtTime(0.15, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.31);
      return;
    }
    case "mute":
      tone(440, 60);
      return;
    case "unmute":
      tone(560, 60);
      return;
    case "ended":
      tone(880, 90);
      setTimeout(() => tone(660, 90), 120);
      return;
    case "error":
      tone(330, 150);
      return;
  }
}

export interface CallAudioOptions {
  /** One 16 kHz mono PCM frame per call, ready for the socket. */
  readonly onFrame: (pcm: ArrayBuffer) => void;
  /** A cue or a sample should never be the reason a call fails. */
  readonly onProblem?: (problem: string) => void;
  /** Mic constraints; echo cancellation keeps the voice from hearing itself. */
  readonly echoCancellation?: boolean;
  /**
   * A context the tap handler already created and resumed. iOS only starts
   * audio from a tap and the call engine is loaded lazily, so the button makes
   * the context itself and hands it over here.
   */
  readonly context?: AudioContext | null;
}

/** Builds the call's AudioContext. Call it synchronously from the tap. */
export function createCallAudioContext(): AudioContext | null {
  try {
    return createContext();
  } catch {
    return null;
  }
}

/**
 * Builds the call's audio. Call this straight from the tap: it creates and
 * resumes the AudioContext synchronously, which is the only way iOS lets a
 * page make sound.
 */
export function createCallAudio(options: CallAudioOptions): CallAudio {
  const echo = options.echoCancellation ?? true;
  let context: AudioContext | null = null;
  let destination: AudioNode | null = null;
  let voiceAnalyser: AnalyserNode | null = null;
  let micAnalyser: AnalyserNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let stream: MediaStream | null = null;
  let scheduled: AudioBufferSourceNode[] = [];
  let playHead = 0;
  let muted = false;
  let closed = false;
  let voiceLevel = 0;
  let micLevel = 0;
  const analysisBuffer: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(256 * 4));

  const problem = (message: string) => options.onProblem?.(message);

  try {
    context = options.context ?? createContext();
    destination = context.createGain();
    (destination as GainNode).gain.value = 1;
    destination.connect(context.destination);
    voiceAnalyser = context.createAnalyser();
    voiceAnalyser.fftSize = 512;
    destination.connect(voiceAnalyser);
    // The call category, when the browser has the API. Silent when it does not.
    const session = (navigator as unknown as { audioSession?: { type?: string } }).audioSession;
    if (session !== undefined && typeof session.type !== "undefined") {
      try {
        session.type = "play-and-record";
      } catch {
        // Older iOS: plain playback, which is what the spike proved works.
      }
    }
  } catch (error) {
    problem(error instanceof Error ? error.message : "No audio on this device.");
  }

  const stopPlayback = () => {
    for (const source of scheduled) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    scheduled = [];
    playHead = 0;
  };

  return {
    get sampleRate() {
      return context?.sampleRate ?? 0;
    },
    play(base64, rate) {
      if (context === null || destination === null) return;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      // An odd trailing byte would make the Int16Array view throw.
      const usable = bytes.length - (bytes.length % 2);
      if (usable === 0) return;
      const ints = new Int16Array(bytes.buffer, 0, usable >> 1);
      const floats = new Float32Array(ints.length);
      for (let index = 0; index < ints.length; index += 1) {
        floats[index] = ints[index]! / 32768;
      }
      const buffer = context.createBuffer(1, floats.length, rate);
      buffer.copyToChannel(floats, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      // Schedule just ahead of the last chunk: back-to-back, never overlapping.
      const at = Math.max(playHead, context.currentTime + 0.03);
      source.start(at);
      playHead = at + buffer.duration;
      scheduled.push(source);
      source.onended = () => {
        const index = scheduled.indexOf(source);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    stopPlayback,
    async startMic() {
      if (context === null || destination === null || closed) return;
      const media = navigator.mediaDevices;
      if (media === undefined) throw new Error("This browser has no microphone access.");
      stream = await media.getUserMedia({
        audio: {
          echoCancellation: echo,
          noiseSuppression: echo,
          autoGainControl: echo,
          channelCount: 1,
        },
      });
      if (context.state !== "running") {
        try {
          await context.resume();
        } catch {
          // A refused resume shows up as silence, not as a failed call.
        }
      }
      if (worklet === null) {
        await context.audioWorklet.addModule(workletUrl);
        worklet = new AudioWorkletNode(context, "pcm16k-capture");
        worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => options.onFrame(event.data);
        // The worklet writes nothing: a silent sink keeps it in the rendering
        // graph, which is what makes process() run at all.
        const silent = context.createGain();
        silent.gain.value = 0;
        worklet.connect(silent);
        silent.connect(context.destination);
      }
      micAnalyser ??= context.createAnalyser();
      if (micAnalyser.fftSize !== 512) micAnalyser.fftSize = 512;
      micSource?.disconnect();
      micSource = context.createMediaStreamSource(stream);
      micSource.connect(worklet);
      micSource.connect(micAnalyser);
      const track = stream.getAudioTracks()[0];
      if (track !== undefined) track.enabled = !muted;
    },
    setMuted(next) {
      muted = next;
      const track = stream?.getAudioTracks()[0];
      // Disabled, never stopped: unmute is instant and keeps the permission.
      if (track !== undefined) track.enabled = !next;
    },
    readLevel(source) {
      const analyser = source === "mic" ? micAnalyser : source === "voice" ? voiceAnalyser : null;
      if (analyser === null) return 0;
      const next = Math.min(1, rms(analyser, analysisBuffer) * 3);
      const previous = source === "mic" ? micLevel : voiceLevel;
      const smoothed =
        next > previous
          ? previous + (next - previous) * ATTACK
          : previous + (next - previous) * RELEASE;
      if (source === "mic") micLevel = smoothed;
      else voiceLevel = smoothed;
      return smoothed;
    },
    cue(kind) {
      if (context === null || closed) return;
      try {
        playCue(context, kind);
      } catch {
        // A missing tone is not worth failing a call over.
      }
    },
    close() {
      closed = true;
      stopPlayback();
      try {
        worklet?.port.close();
      } catch {
        // Already gone.
      }
      worklet?.disconnect();
      worklet = null;
      micSource?.disconnect();
      micSource = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      micLevel = 0;
      voiceLevel = 0;
      void context?.close().catch(() => undefined);
      context = null;
      destination = null;
      voiceAnalyser = null;
      micAnalyser = null;
    },
  };
}
