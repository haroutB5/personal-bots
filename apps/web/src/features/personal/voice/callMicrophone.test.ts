/**
 * The microphone request the tap handler makes.
 *
 * These are the two properties the iPhone bug turned on: `getUserMedia` is
 * called synchronously (nothing may await before it, or WebKit refuses it with
 * NotAllowedError and no prompt), and a stream that arrives after the call is
 * over is stopped instead of being left live behind a closed screen.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { requestMicrophone } from "./callMicrophone";

/** A MediaStream with the two track methods the audio layer touches. */
function fakeStream(): MediaStream {
  const track = { stop: vi.fn(), enabled: true, kind: "audio" };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    track,
  } as unknown as MediaStream & { track: { stop: () => void } };
}

function stubMediaDevices(mediaDevices: unknown): void {
  vi.stubGlobal("navigator", { mediaDevices });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestMicrophone", () => {
  it("asks for the microphone synchronously, with the call's constraints", () => {
    const getUserMedia = vi.fn(
      (_constraints: MediaStreamConstraints) => new Promise<MediaStream>(() => undefined),
    );
    stubMediaDevices({ getUserMedia });

    const request = requestMicrophone();

    // The whole point: this call has already happened before anything can
    // await. `start` in VoiceCallProvider calls this function as its first
    // statement, above its first `await`.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    expect(request.stream).toBeInstanceOf(Promise);
    request.stop();
  });

  it("stops the tracks of a stream that arrives after the call is over", async () => {
    const stream = fakeStream();
    let release: (value: MediaStream) => void = () => undefined;
    const pending = new Promise<MediaStream>((resolve) => {
      release = resolve;
    });
    stubMediaDevices({ getUserMedia: () => pending });

    const request = requestMicrophone();
    // The owner hung up, or the pass failed, while the prompt was still up.
    request.stop();
    expect(
      (stream as unknown as { track: { stop: () => void } }).track.stop,
    ).not.toHaveBeenCalled();

    release(stream);
    await request.stream;
    await Promise.resolve();

    expect((stream as unknown as { track: { stop: () => void } }).track.stop).toHaveBeenCalledTimes(
      1,
    );
  });

  it("leaves the tracks alone when the call is still running", async () => {
    const stream = fakeStream();
    stubMediaDevices({ getUserMedia: () => Promise.resolve(stream) });

    const request = requestMicrophone();
    await request.stream;
    await Promise.resolve();

    expect(
      (stream as unknown as { track: { stop: () => void } }).track.stop,
    ).not.toHaveBeenCalled();
  });

  it("rejects with the browser's own error, and never leaks an unhandled rejection", async () => {
    const refusal = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    stubMediaDevices({ getUserMedia: () => Promise.reject(refusal) });

    const request = requestMicrophone();
    // A call that ends before anything awaits the stream: the rejection is
    // handled by the request itself.
    request.stop();
    await expect(request.stream).rejects.toBe(refusal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("rejects when the browser has no microphone API at all", async () => {
    stubMediaDevices(undefined);
    const request = requestMicrophone();
    await expect(request.stream).rejects.toThrow("no microphone access");
  });
});
