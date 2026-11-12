import { describe, expect, it } from "vite-plus/test";

import { claudeAutoCompactWindow } from "./personalBotContextLimits.ts";

const bot = (configured: string | undefined, personalTaskChat: boolean, env = {}) =>
  claudeAutoCompactWindow({ configured, personalBot: true, personalTaskChat, env });

describe("claudeAutoCompactWindow", () => {
  it("compacts a bot chat at the owner's number, task chat or not", () => {
    // Claude compacts 33k below the window, so 300k needs a 333k window.
    expect(bot("300000", true)).toBe(333_000);
    expect(bot("300000", false)).toBe(333_000);
    expect(bot("150000", true)).toBe(183_000);
  });

  it("never asks for more than Claude's largest window", () => {
    expect(bot("1000000", true)).toBe(1_000_000);
  });

  it("uses the 200k task window only when the owner set nothing", () => {
    expect(bot("", true)).toBe(200_000);
    expect(bot(undefined, true)).toBe(200_000);
    expect(bot("", false)).toBeUndefined();
    expect(bot("", true, { PERSONAL_TASK_AUTO_COMPACT: "off" })).toBeUndefined();
  });

  it("leaves a thread that is not a bot chat on the owner's setting as typed", () => {
    expect(
      claudeAutoCompactWindow({
        configured: "300000",
        personalBot: false,
        personalTaskChat: false,
      }),
    ).toBe(300_000);
    expect(
      claudeAutoCompactWindow({ configured: "", personalBot: false, personalTaskChat: true }),
    ).toBeUndefined();
  });
});
