import { describe, expect, it } from "vite-plus/test";

import { errorCopyFor, type CallErrorActions } from "./callErrorCopy";

function actions() {
  const calls: string[] = [];
  const made: CallErrorActions = {
    onSettings: () => calls.push("settings"),
    onBotPage: () => calls.push("bot"),
    onRetry: () => calls.push("retry"),
    onClose: () => calls.push("close"),
    onOpenAppSettings: () => calls.push("app-settings"),
  };
  return { calls, made };
}

describe("errorCopyFor", () => {
  it("returns nothing without a code", () => {
    expect(errorCopyFor(null, null, actions().made)).toBeNull();
  });

  it("offers Open Settings first when Android will not ask again", () => {
    const { calls, made } = actions();
    const copy = errorCopyFor("mic_blocked", "blocked", made);
    expect(copy?.primary).toBe("Open Settings");
    copy?.onPrimary();
    copy?.onSecondary?.();
    expect(calls).toEqual(["app-settings", "close"]);
  });

  it("offers Try again first after a plain denial", () => {
    const { calls, made } = actions();
    const copy = errorCopyFor("mic_blocked", "denied", made);
    expect(copy?.primary).toBe("Try again");
    copy?.onPrimary();
    expect(calls).toEqual(["retry"]);
  });

  it("gives every code a way out", () => {
    const codes = [
      "no_key",
      "key_rejected",
      "calls_not_allowed",
      "not_owner_chat",
      "sensitive_chat",
      "rate_limited",
      "key_quota",
      "mic_blocked",
      "google_unavailable",
      "unknown",
    ] as const;
    for (const code of codes) {
      const { calls, made } = actions();
      const copy = errorCopyFor(code, "denied", made);
      expect(copy).not.toBeNull();
      const closes = copy?.primary === "Close" || copy?.secondary === "Close";
      expect(closes).toBe(true);
      const close = copy?.primary === "Close" ? copy.onPrimary : copy?.onSecondary;
      close?.();
      expect(calls).toContain("close");
    }
  });

  it("does not add a second Close when Close is already primary", () => {
    const copy = errorCopyFor("key_quota", null, actions().made);
    expect(copy?.secondary).toBeUndefined();
  });

  it("routes the key errors to Settings and the bot error to the bot page", () => {
    const { calls, made } = actions();
    errorCopyFor("no_key", null, made)?.onPrimary();
    errorCopyFor("calls_not_allowed", null, made)?.onPrimary();
    expect(calls).toEqual(["settings", "bot"]);
  });
});
