/**
 * The call's audio, driven with a fake AudioContext and the tap's own
 * microphone request.
 *
 * What these prove, in the words of the iPhone bug (16 Oct 2026):
 * - the microphone the tap asked for is the one used, and the browser is never
 *   asked a second time from inside `startMic` (the call that WebKit refuses);
 * - a stream that lands after the call is over is stopped, never left live
 *   behind a closed screen;
 * - the browser's own refusal reaches the caller unchanged, so the screen can
 *   tell a denied permission from a missing device.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { type MicrophoneRequest, requestMicrophone } from "./callMicrophone";
import { createCallAudio } from "./callAudio";

interface FakeTrack {
  readonly stop: ReturnType<typeof vi.fn>;
  enabled: boolean;
  readonly kind: string;
}

function fakeStream(): { stream: MediaStream; track: FakeTrack } {
  const track: FakeTrack = { stop: vi.fn(), enabled: true, kind: "audio" };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

/** The parts of an AudioContext this module touches. */
function fakeContext(): {
  context: AudioContext;
  micSources: MediaStream[];
  closed: () => boolean;
} {
  const micSources: MediaStream[] = [];
  let closed = false;
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const context = {
    state: "running",
    sampleRate: 48_000,
    currentTime: 0,
    destination: node(),
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createAnalyser: () => ({ ...node(), fftSize: 512, getFloatTimeDomainData: vi.fn() }),
    createMediaStreamSource: (stream: MediaStream) => {
      micSources.push(stream);
      return node();
    },
    createBuffer: () => ({ duration: 0, copyToChannel: vi.fn() }),
    createBufferSource: () => ({ ...node(), start: vi.fn(), stop: vi.fn(), buffer: null }),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      closed = true;
    }),
    audioWorklet: { addModule: vi.fn(async () => undefined) },
  } as unknown as AudioContext;
  return { context, micSources, closed: () => closed };
}

class FakeWorklet {
  readonly port = { onmessage: null as unknown, close: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCallAudio with the tap's microphone", () => {
  it("uses the tap's request and never asks the browser again", async () => {
    const { stream, track } = fakeStream();
    const getUserMedia = vi.fn(() => Promise.reject(new Error("asked twice")));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    const fake = fakeContext();
    const mic: MicrophoneRequest = { stream: Promise.resolve(stream), stop: vi.fn() };

    const audio = createCallAudio({ context: fake.context, onFrame: vi.fn(), mic });
    await audio.startMic();

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fake.micSources).toEqual([stream]);
    expect(track.enabled).toBe(true);
    audio.close();
  });

  it("stops the tracks when the call ends while the prompt is still open", async () => {
    const { stream, track } = fakeStream();
    let release: (value: MediaStream) => void = () => undefined;
    const pending = new Promise<MediaStream>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => pending } });
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    const fake = fakeContext();
    // Exactly what the tap handler builds: the browser's promise, wrapped.
    const mic = requestMicrophone();

    const audio = createCallAudio({ context: fake.context, onFrame: vi.fn(), mic });
    const started = audio.startMic();
    // The owner taps End, or leaves the app: the call is over before the
    // permission prompt is answered.
    audio.close();
    release(stream);
    await started;

    expect(track.stop).toHaveBeenCalled();
    // The stream was never wired into the graph.
    expect(fake.micSources).toEqual([]);
  });

  it("stops the tracks of a live call when it closes", async () => {
    const { stream, track } = fakeStream();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } });
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    const fake = fakeContext();
    const mic: MicrophoneRequest = { stream: Promise.resolve(stream), stop: vi.fn() };

    const audio = createCallAudio({ context: fake.context, onFrame: vi.fn(), mic });
    await audio.startMic();
    expect(track.stop).not.toHaveBeenCalled();

    audio.close();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("surfaces the browser's refusal unchanged, so the screen can name it", async () => {
    const refusal = Object.assign(new Error("The request is not allowed"), {
      name: "NotAllowedError",
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream().stream) },
    });
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    const fake = fakeContext();
    const mic: MicrophoneRequest = { stream: Promise.reject(refusal), stop: vi.fn() };

    const audio = createCallAudio({ context: fake.context, onFrame: vi.fn(), mic });
    await expect(audio.startMic()).rejects.toBe(refusal);
    audio.close();
  });

  it("asks the browser itself when the tap made no request (desktop, tests)", async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn((_constraints: MediaStreamConstraints) => Promise.resolve(stream));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioWorkletNode", FakeWorklet);
    const fake = fakeContext();

    const audio = createCallAudio({ context: fake.context, onFrame: vi.fn() });
    await audio.startMic();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    audio.close();
  });
});
