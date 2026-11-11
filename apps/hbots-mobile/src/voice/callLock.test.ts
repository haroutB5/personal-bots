import { describe, expect, it } from "vite-plus/test";

import { lockCallLine } from "./callLock";
import { EMPTY_SNAPSHOT, type CallView } from "./callSession";

const call = {
  threadId: "secret-thread",
  botId: "secret-bot",
  botName: "Private Bot Name",
  avatarShape: "blob",
  avatarColor: "#fff",
  startedAtMs: 0,
  minimised: false,
};

function view(status: string, overrides: Partial<CallView> = {}): CallView {
  return {
    call,
    snapshot: { ...EMPTY_SNAPSHOT, state: { ...EMPTY_SNAPSHOT.state, status } as never },
    captionsOn: true,
    micRefusal: null,
    held: false,
    route: null,
    recovered: false,
    outside: null,
    ...overrides,
  };
}

describe("lockCallLine", () => {
  it("says nothing when there is no call", () => {
    expect(lockCallLine(view("live", { call: null }))).toBeNull();
  });

  it("says a call is running and never names the bot, the chat or a caption", () => {
    const line = lockCallLine(view("live"));
    expect(line?.title).toBe("Call in progress");
    const text = JSON.stringify(line);
    expect(text).not.toContain("Private Bot Name");
    expect(text).not.toContain("secret-thread");
    expect(text).not.toContain("secret-bot");
  });

  it("says the call is paused when another app holds the audio", () => {
    expect(lockCallLine(view("live", { held: true }))?.body).toBe("The call is paused.");
  });

  it("drops the line once the call has failed or finished", () => {
    expect(lockCallLine(view("error"))).toBeNull();
    expect(lockCallLine(view("ended"))).toBeNull();
  });
});
