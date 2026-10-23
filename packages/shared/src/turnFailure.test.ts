import { describe, expect, it } from "vite-plus/test";

import { classifyTurnFailure, isRefusedTurnInput, isTransientTurnFailure } from "./turnFailure.ts";

describe("classifyTurnFailure", () => {
  it("reads the failure that ended the owner's audit run as an upstream fault", () => {
    // Verbatim from the incident: the message was delivered, the reply died.
    const raw = "Error from provider (Console): Upstream request failed: Endpoint is unavailable.";
    expect(classifyTurnFailure(raw)).toBe("upstream");
    expect(isTransientTurnFailure(raw)).toBe(true);
  });

  it.each([
    ["Upstream request failed: Endpoint is unavailable.", "upstream"],
    ["HTTP 503 Service Unavailable", "upstream"],
    ["502 Bad Gateway", "upstream"],
    ["Overloaded", "upstream"],
    ["Request timed out after 120000ms", "timeout"],
    ["fetch failed: getaddrinfo ENOTFOUND api.anthropic.com", "network"],
    ["read ECONNRESET", "network"],
    ["socket hang up", "network"],
    [
      "TypeError: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?",
      "network",
    ],
    ["ssl3_get_record:wrong version number", "network"],
    ["getaddrinfo EAI_AGAIN opencode.ai", "network"],
  ] as const)("calls %j transient (%s)", (raw, kind) => {
    expect(classifyTurnFailure(raw)).toBe(kind);
    expect(isTransientTurnFailure(raw)).toBe(true);
  });

  it.each([
    ["You've hit your session limit · resets 10:10pm (Europe/London)", "usage_limit"],
    ["API Error: 429 rate_limit_error", "usage_limit"],
    ["Quota exceeded for this account", "usage_limit"],
    ["Error: Not logged in · Please run /login", "signin"],
    ["401 Unauthorized", "signin"],
    ["403 Forbidden", "signin"],
    ["model not found: claude-does-not-exist", "invalid_request"],
    ["400 Bad Request: invalid_request_error", "invalid_request"],
    ["Session was closed before the turn finished", "session_closed"],
    ["Turn aborted by user", "interrupted"],
    ["something nobody has seen before", "unknown"],
  ] as const)("never retries %j (%s)", (raw, kind) => {
    expect(classifyTurnFailure(raw)).toBe(kind);
    expect(isTransientTurnFailure(raw)).toBe(false);
  });

  it("lets a refusal win over a transient-looking word in the same line", () => {
    // The expensive mistake: a 429 body that also mentions a gateway must not
    // be re-run. Every "never retry" kind is tested before every transient one.
    const raw = "429 rate_limit_error from the upstream gateway (503 reported downstream)";
    expect(classifyTurnFailure(raw)).toBe("usage_limit");
    expect(isTransientTurnFailure(raw)).toBe(false);
  });

  it("does not read a millisecond figure as an HTTP status", () => {
    expect(classifyTurnFailure("gave up after 500ms")).not.toBe("upstream");
  });
});

describe("isRefusedTurnInput", () => {
  it("reads the DeepSeek image refusal as one sending the same message again cannot fix", () => {
    const raw =
      'DeepSeek can\'t read this image "carrier.png" (8.1 MB): the DeepSeek engine takes ' +
      "images up to 2.0 MB. Send a smaller photo, or send it to a Claude bot.";
    expect(isRefusedTurnInput(raw)).toBe(true);
    // Retrying it is still not a transient fault, so the server agrees.
    expect(isTransientTurnFailure(raw)).toBe(false);
  });

  it("leaves every failure a Retry can still fix alone", () => {
    for (const raw of [
      "spawn claude ENOENT",
      "The reply took too long and was stopped. Try again.",
      "Error: Not logged in · Please run /login",
      "DeepSeek could not take this message: the harness ran out of stack on it.",
    ]) {
      expect(isRefusedTurnInput(raw)).toBe(false);
    }
  });
});
