/**
 * The tap handler's own contract, on the provider that owns it (16 Oct 2026).
 *
 * The iPhone bug: every call failed in about 0.1 s with WebKit's
 * NotAllowedError, because `getUserMedia` ran after the lazy chunks and the
 * pass mint had already awaited. WebKit only honours it while the user's
 * gesture is still being handled, so the provider must ask for the microphone
 * in the same task as the tap, before its first `await`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type VoiceCallContextValue, VoiceCallProvider, useVoiceCall } from "./VoiceCallProvider";

const INPUT = {
  threadId: "thread-1",
  botId: "bot-cto",
  botName: "CTO",
  avatarShape: "blob",
  avatarColor: "#aabbcc",
} as const;

interface FakeTrack {
  readonly stop: ReturnType<typeof vi.fn>;
  enabled: boolean;
}

function fakeStream(): { stream: MediaStream; track: FakeTrack } {
  const track: FakeTrack = { stop: vi.fn(), enabled: true };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function stubMedia(getUserMedia: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
}

let root: Root;
let voice: VoiceCallContextValue | null = null;

function Probe() {
  voice = useVoiceCall();
  return null;
}

beforeEach(async () => {
  // The probe renders no DOM nodes, but ReactDOM still needs an event target
  // (the same shape the composer-hook tests use).
  const documentStub = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: documentStub,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", {
    document: documentStub,
    HTMLIFrameElement: EventTarget,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
  await act(() =>
    root.render(
      <VoiceCallProvider environmentId={null}>
        <Probe />
      </VoiceCallProvider>,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
  voice = null;
});

describe("the call tap", () => {
  it("asks for the microphone before start's first await", async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(fakeStream().stream));
    stubMedia(getUserMedia);
    let starting: Promise<void> = Promise.resolve();

    // The synchronous half of the tap, and nothing more: the request must
    // already have been made here. A getUserMedia that runs after the first
    // await is the one WebKit refuses with no prompt.
    act(() => {
      starting = voice!.start(INPUT);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      await starting;
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      voice!.end();
      await Promise.resolve();
    });
  });

  it("takes one microphone request for two taps", async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(fakeStream().stream));
    stubMedia(getUserMedia);

    act(() => {
      void voice!.start(INPUT);
      void voice!.start(INPUT);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      voice!.end();
      await Promise.resolve();
    });
  });

  it("lets the tap's microphone go as soon as the call is over", async () => {
    const { stream, track } = fakeStream();
    stubMedia(vi.fn(() => Promise.resolve(stream)));

    // No laptop is connected in this harness, so the pass fails and the tap's
    // microphone is already stopped: a call that never starts cannot leave a
    // live track behind its card.
    await act(async () => {
      await voice!.start(INPUT);
    });
    expect(track.stop).toHaveBeenCalledTimes(1);

    // And the owner's own Close (or the chevron) is idempotent on top of it.
    await act(async () => {
      voice!.end();
      await Promise.resolve();
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
