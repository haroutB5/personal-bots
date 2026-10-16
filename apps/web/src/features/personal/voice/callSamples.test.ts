/**
 * Playing a voice sample: the two things that decide whether it works on an
 * iPhone at all.
 *
 * 1. The audio context is created and resumed SYNCHRONOUSLY in the tap, before
 *    anything is fetched (`unlock()`), because iOS only starts audio from a
 *    user gesture and an `await` loses it.
 * 2. Only one clip plays at a time.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { base64ToBytes, createVoiceSampleAudio } from "./callSamples";

interface FakeSource {
  buffer: unknown;
  onended: (() => void) | null;
  connected: number;
  started: number;
  stopped: number;
  disconnected: number;
  connect: () => void;
  start: () => void;
  stop: () => void;
  disconnect: () => void;
}

const makeFakes = () => {
  const sources: Array<FakeSource> = [];
  const resume = vi.fn(async () => undefined);
  const decodeAudioData = vi.fn(async () => ({ duration: 1 }) as unknown as AudioBuffer);
  const close = vi.fn(async () => undefined);
  const context = {
    state: "suspended",
    resume,
    decodeAudioData,
    createBufferSource: () => {
      const source: FakeSource = {
        buffer: null,
        onended: null,
        connected: 0,
        started: 0,
        stopped: 0,
        disconnected: 0,
        connect: () => {
          source.connected += 1;
        },
        start: () => {
          source.started += 1;
        },
        stop: () => {
          source.stopped += 1;
        },
        disconnect: () => {
          source.disconnected += 1;
        },
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    destination: {} as AudioNode,
    close,
  };
  const create = vi.fn(() => context);
  return { create, context, sources, resume, decodeAudioData, close };
};

describe("base64ToBytes", () => {
  it("decodes the server's clip byte for byte", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    const base64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(base64ToBytes(base64))).toEqual(Array.from(bytes));
  });
});

describe("createVoiceSampleAudio", () => {
  it("creates and resumes the context synchronously, before any fetch", () => {
    const fakes = makeFakes();
    const audio = createVoiceSampleAudio(fakes.create);
    audio.unlock();
    // Both happened during the call itself: that is what the tap needs.
    expect(fakes.create).toHaveBeenCalledTimes(1);
    expect(fakes.resume).toHaveBeenCalledTimes(1);
    audio.unlock();
    // A second tap reuses the same context and resumes it again, harmlessly.
    expect(fakes.create).toHaveBeenCalledTimes(1);
    expect(fakes.resume).toHaveBeenCalledTimes(2);
  });

  it("decodes the clip and plays it through the context", async () => {
    const fakes = makeFakes();
    const audio = createVoiceSampleAudio(fakes.create);
    audio.unlock();
    await audio.play(new Uint8Array([1, 2, 3, 4]));
    expect(fakes.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(fakes.sources).toHaveLength(1);
    expect(fakes.sources[0]!.started).toBe(1);
    expect(fakes.sources[0]!.connected).toBe(1);
  });

  it("stops the previous clip when another voice is played", async () => {
    const fakes = makeFakes();
    const audio = createVoiceSampleAudio(fakes.create);
    audio.unlock();
    await audio.play(new Uint8Array([1]));
    await audio.play(new Uint8Array([2]));
    expect(fakes.sources).toHaveLength(2);
    expect(fakes.sources[0]!.stopped).toBe(1);
    expect(fakes.sources[0]!.disconnected).toBe(1);
    expect(fakes.sources[1]!.started).toBe(1);
  });

  it("reports the end of a clip once, so the button can stop showing Pause", async () => {
    const fakes = makeFakes();
    const audio = createVoiceSampleAudio(fakes.create);
    const ended = vi.fn();
    audio.onEnded(ended);
    await audio.play(new Uint8Array([1]));
    fakes.sources[0]!.onended?.();
    expect(ended).toHaveBeenCalledTimes(1);
    // The source that has ended no longer counts as playing.
    audio.stop();
    expect(fakes.sources[0]!.stopped).toBe(0);
  });

  it("closes the context on dispose, and tolerates a stop with nothing playing", () => {
    const fakes = makeFakes();
    const audio = createVoiceSampleAudio(fakes.create);
    audio.unlock();
    audio.stop();
    audio.dispose();
    expect(fakes.close).toHaveBeenCalledTimes(1);
    expect(fakes.create).toHaveBeenCalledTimes(1);
  });
});
