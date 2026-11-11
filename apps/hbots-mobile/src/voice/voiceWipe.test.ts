import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ endCall: vi.fn(), wipe: vi.fn() }));
vi.mock("./hbotsVoice", () => ({ hbotsVoice: native }));

import { registerCallSessionForWipe, wipeVoiceCalls } from "./voiceWipe";

beforeEach(() => {
  native.endCall.mockClear();
  native.wipe.mockClear();
  registerCallSessionForWipe(null);
});

describe("wipeVoiceCalls", () => {
  it("wipes through the running session so the engine ends first", () => {
    const session = { wipe: vi.fn() };
    registerCallSessionForWipe(session);
    wipeVoiceCalls();
    expect(session.wipe).toHaveBeenCalledOnce();
  });

  it("stops the service and clears the marker when no session is registered", () => {
    wipeVoiceCalls();
    expect(native.endCall).toHaveBeenCalledOnce();
    expect(native.wipe).toHaveBeenCalledOnce();
  });
});
