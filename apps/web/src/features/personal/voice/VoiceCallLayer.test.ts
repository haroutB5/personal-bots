/**
 * The call screen's own words for each way a call can fail, including the one
 * the server sends for a chat that has had a private site open.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { chevronAction, errorCopyFor } from "./VoiceCallLayer";

const actions = {
  onSettings: () => undefined,
  onBotPage: () => undefined,
  onRetry: () => undefined,
  onClose: () => undefined,
};

describe("errorCopyFor", () => {
  it("says why a chat that opened a private site cannot be called", () => {
    const copy = errorCopyFor("sensitive_chat", actions);
    expect(copy?.title).toBe("Voice calls are off in chats that opened a private site");
    expect(copy?.body).toContain("stay on your laptop");
  });

  it("names the voice model as the part that ran out, and says search is not the cause", () => {
    const copy = errorCopyFor("key_quota", actions);
    expect(copy?.title).toBe("The Gemini voice is out of quota");
    expect(copy?.body).toContain("voice model");
    expect(copy?.body).toContain("Searching is not the problem");
    // The old, vaguer wording is gone.
    expect(`${copy?.title} ${copy?.body}`).not.toContain("paused this key");
  });

  it("does not blame Google for our own start limit", () => {
    const copy = errorCopyFor("rate_limited", actions);
    expect(copy?.title).toBe("Calls are busy right now");
    expect(`${copy?.title} ${copy?.body}`).not.toContain("paused this key");
  });

  it("words a blocked microphone as something only Settings can fix", () => {
    const copy = errorCopyFor("mic_blocked", actions);
    expect(copy?.title).toBe("Microphone blocked");
    expect(copy?.body).toBe("Allow the microphone for Bots in iPhone Settings, then try again.");
    // Close plus Try again: the way out the failed screen never had.
    expect([copy?.primary, copy?.secondary].sort()).toEqual(["Close", "Try again"]);
  });

  it("covers every code the call screen can render", () => {
    for (const code of [
      "no_key",
      "key_rejected",
      "key_quota",
      "calls_not_allowed",
      "not_owner_chat",
      "sensitive_chat",
      "rate_limited",
      "google_unavailable",
      "invalid_input",
      "not_found",
      "send_failed",
      "mic_blocked",
      "unknown",
    ] as const) {
      const copy = errorCopyFor(code, actions);
      expect(copy, code).not.toBeNull();
      expect(copy!.title.length, code).toBeGreaterThan(0);
      expect(copy!.body.length, code).toBeGreaterThan(0);
      expect(copy!.primary.length, code).toBeGreaterThan(0);
      // The 16 Oct 2026 bug: the failed screen offered only "Try again", and
      // the owner had to kill the app. Every card can leave the call.
      const buttons = [copy!.primary, copy!.secondary].filter((label) => label !== undefined);
      expect(buttons, code).toContain("Close");
    }
  });

  it("wires that Close to the action it was given, on every card", () => {
    const onClose = vi.fn();
    const codes = [
      "no_key",
      "key_rejected",
      "key_quota",
      "calls_not_allowed",
      "not_owner_chat",
      "sensitive_chat",
      "rate_limited",
      "google_unavailable",
      "send_failed",
      "mic_blocked",
      "unknown",
    ] as const;
    for (const code of codes) {
      const copy = errorCopyFor(code, { ...actions, onClose });
      if (copy!.primary === "Close") copy!.onPrimary();
      else copy!.onSecondary?.();
    }
    // One tap per card, every one of them the same way out.
    expect(onClose).toHaveBeenCalledTimes(codes.length);
  });

  it("is null while nothing has gone wrong", () => {
    expect(errorCopyFor(null, actions)).toBeNull();
  });
});

describe("chevronAction", () => {
  it("minimises a call that is still running", () => {
    expect(chevronAction("connecting")).toBe("minimise");
    expect(chevronAction("live")).toBe("minimise");
    expect(chevronAction("reconnecting")).toBe("minimise");
  });

  it("leaves the screen when the call has failed or ended", () => {
    // The chevron must not be a dead control on the screen that would not close
    // (16 Oct 2026).
    expect(chevronAction("error")).toBe("leave");
    expect(chevronAction("ended")).toBe("leave");
  });
});
