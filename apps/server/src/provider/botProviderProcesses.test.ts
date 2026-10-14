import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  forgetBotProviderProcess,
  listBotProviderProcesses,
  registerBotProviderProcess,
  resetBotProviderProcesses,
} from "./botProviderProcesses.ts";

afterEach(() => resetBotProviderProcesses());

describe("botProviderProcesses", () => {
  it("records the process a chat spawned", () => {
    registerBotProviderProcess({ threadId: "thread-it", provider: "codex", pid: 25_184 });
    expect(listBotProviderProcesses()).toEqual([
      { threadId: "thread-it", provider: "codex", pid: 25_184 },
    ]);
  });

  it("replaces the process a resumed chat left behind", () => {
    registerBotProviderProcess({ threadId: "thread-it", provider: "codex", pid: 25_184 });
    registerBotProviderProcess({ threadId: "thread-it", provider: "codex", pid: 25_999 });
    expect(listBotProviderProcesses()).toEqual([
      { threadId: "thread-it", provider: "codex", pid: 25_999 },
    ]);
  });

  it("forgets a chat's process when it ends, and keeps a newer one", () => {
    registerBotProviderProcess({ threadId: "thread-it", provider: "codex", pid: 25_184 });
    forgetBotProviderProcess("thread-it", 25_184);
    expect(listBotProviderProcesses()).toEqual([]);

    registerBotProviderProcess({ threadId: "thread-it", provider: "codex", pid: 25_999 });
    forgetBotProviderProcess("thread-it", 25_184); // the old one ending late
    expect(listBotProviderProcesses()).toHaveLength(1);
  });

  it("drops an older chat's entry when a PID is reused", () => {
    registerBotProviderProcess({ threadId: "thread-it", provider: "codex", pid: 25_184 });
    registerBotProviderProcess({ threadId: "thread-qa", provider: "claudeAgent", pid: 25_184 });
    expect(listBotProviderProcesses()).toEqual([
      { threadId: "thread-qa", provider: "claudeAgent", pid: 25_184 },
    ]);
  });

  it("refuses a number that cannot be a process", () => {
    expect(
      registerBotProviderProcess({ threadId: "thread-it", provider: "codex", pid: 4 }),
    ).toBeNull();
    expect(listBotProviderProcesses()).toEqual([]);
  });
});
