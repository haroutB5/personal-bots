/**
 * The call screen's own words for each way a call can fail, including the one
 * the server sends for a chat that has had a private site open.
 */
import { describe, expect, it } from "vite-plus/test";

import { errorCopyFor } from "./VoiceCallLayer";

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

  it("names a spent free tier as out of quota", () => {
    expect(errorCopyFor("key_quota", actions)?.title).toBe("Gemini is out of quota");
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
      "unknown",
    ] as const) {
      const copy = errorCopyFor(code, actions);
      expect(copy, code).not.toBeNull();
      expect(copy!.title.length, code).toBeGreaterThan(0);
      expect(copy!.body.length, code).toBeGreaterThan(0);
      expect(copy!.primary.length, code).toBeGreaterThan(0);
    }
  });

  it("is null while nothing has gone wrong", () => {
    expect(errorCopyFor(null, actions)).toBeNull();
  });
});
