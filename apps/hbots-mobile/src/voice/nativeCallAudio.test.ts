import { describe, expect, it, vi } from "vite-plus/test";
import { isMicrophoneBlocked } from "@hbots/personal-client/conversation/voice/callState";

import type { HbotsVoiceModule } from "./hbotsVoice";
import { createNativeCallAudio, decodeBase64Pcm } from "./nativeCallAudio";

function module(overrides: Partial<HbotsVoiceModule> = {}) {
  let frame: ((event: { pcm: string }) => void) | null = null;
  const remove = vi.fn();
  const native = {
    startCapture: vi.fn(async () => undefined),
    setMuted: vi.fn(),
    play: vi.fn(),
    stopPlayback: vi.fn(),
    cue: vi.fn(),
    readLevel: vi.fn(() => 0.25),
    endCall: vi.fn(),
    addListener: vi.fn((_event: string, listener: (event: { pcm: string }) => void) => {
      frame = listener;
      return { remove };
    }),
    ...overrides,
  } as unknown as HbotsVoiceModule;
  return { native, remove, send: (pcm: string) => frame?.({ pcm }) };
}

describe("decodeBase64Pcm", () => {
  it("decodes little endian PCM16 bytes", () => {
    const buffer = decodeBase64Pcm(globalThis.btoa(String.fromCharCode(1, 0, 255, 127)));
    expect([...new Int16Array(buffer)]).toEqual([1, 32767]);
  });

  it("drops a trailing odd byte rather than splitting a sample", () => {
    const buffer = decodeBase64Pcm(globalThis.btoa(String.fromCharCode(1, 0, 9)));
    expect(buffer.byteLength).toBe(2);
  });
});

describe("createNativeCallAudio", () => {
  it("hands microphone frames to the engine after the capture starts", async () => {
    const { native, send } = module();
    const audio = createNativeCallAudio(native);
    const heard: number[] = [];
    audio.onFrame((pcm) => heard.push(pcm.byteLength));
    await audio.startMic();
    send(globalThis.btoa(String.fromCharCode(1, 0, 2, 0)));
    expect(heard).toEqual([4]);
  });

  it("reports a refused microphone as a blocked microphone", async () => {
    const { native } = module({
      startCapture: vi.fn(async () => {
        throw Object.assign(new Error("Microphone permission denied"), {
          code: "ERR_VOICE_MIC",
        });
      }),
    });
    const audio = createNativeCallAudio(native);
    const failure = await audio.startMic().catch((error: unknown) => error);
    expect(isMicrophoneBlocked(failure)).toBe(true);
  });

  it("reports a busy microphone as something other than a blocked one", async () => {
    const { native } = module({
      startCapture: vi.fn(async () => {
        throw new Error("The recorder is busy");
      }),
    });
    const failure = await createNativeCallAudio(native)
      .startMic()
      .catch((error: unknown) => error);
    expect(isMicrophoneBlocked(failure)).toBe(false);
  });

  it("ends the call and stops listening on close, and ignores later calls", async () => {
    const { native, remove, send } = module();
    const audio = createNativeCallAudio(native);
    const heard: number[] = [];
    audio.onFrame((pcm) => heard.push(pcm.byteLength));
    await audio.startMic();
    audio.close();
    expect(remove).toHaveBeenCalledOnce();
    expect(native.endCall).toHaveBeenCalledOnce();
    send(globalThis.btoa("ab"));
    audio.play("AAAA", 24_000);
    audio.setMuted(true);
    expect(heard).toEqual([]);
    expect(native.play).not.toHaveBeenCalled();
    expect(native.setMuted).not.toHaveBeenCalled();
    expect(audio.readLevel("mic")).toBe(0);
  });

  it("forwards playback, mute, cues and levels while open", () => {
    const { native } = module();
    const audio = createNativeCallAudio(native);
    audio.play("AAAA", 24_000);
    audio.setMuted(true);
    audio.cue("connected");
    audio.stopPlayback();
    expect(native.play).toHaveBeenCalledWith("AAAA", 24_000);
    expect(native.setMuted).toHaveBeenCalledWith(true);
    expect(native.cue).toHaveBeenCalledWith("connected");
    expect(audio.readLevel("voice")).toBe(0.25);
  });

  it("forwards the mic lease to the native module until the audio is closed", () => {
    const holdMicUntil = vi.fn();
    const { native } = module({ holdMicUntil } as never);
    const audio = createNativeCallAudio(native);
    audio.holdMicUntil?.("quiet", 120_000);
    expect(holdMicUntil).toHaveBeenCalledExactlyOnceWith("quiet", 120_000);
    audio.close();
    audio.holdMicUntil?.("limit", 1_000);
    expect(holdMicUntil).toHaveBeenCalledTimes(1);
  });
});
