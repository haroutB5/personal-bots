import { describe, expect, it } from "vite-plus/test";

import { openCodeRetryInfo } from "./openCodeRetryInfo.ts";

const NEXT = Date.parse("2026-09-15T10:47:16.000Z");

describe("openCodeRetryInfo", () => {
  it("reads a 429 or a rate-limit message as rate limited, with the reported next attempt", () => {
    expect(
      openCodeRetryInfo({ attempt: 2, message: "Rate limit exceeded (429)", next: NEXT }),
    ).toEqual({
      kind: "rate_limited",
      retryAt: "2026-09-15T10:47:16.000Z",
      attempt: 2,
      reason: "Rate limit exceeded (429)",
    });
    expect(openCodeRetryInfo({ attempt: 1, message: "Too Many Requests", next: NEXT }).kind).toBe(
      "rate_limited",
    );
  });

  it("classifies from the action too and prefers its message as the reason", () => {
    const info = openCodeRetryInfo({
      attempt: 1,
      message: "Provider returned an error",
      next: NEXT,
      action: { reason: "free_usage", title: "Free usage exceeded", message: "Try again later." },
    });
    expect(info.kind).toBe("rate_limited");
    expect(info.reason).toBe("Try again later.");
  });

  it("reads a transport failure as retrying", () => {
    expect(openCodeRetryInfo({ attempt: 3, message: "502 Bad Gateway", next: NEXT }).kind).toBe(
      "retrying",
    );
  });

  it("never invents a retry time from a delay-sized or missing value", () => {
    expect(openCodeRetryInfo({ attempt: 1, message: "429", next: 30_000 }).retryAt).toBeUndefined();
    expect(openCodeRetryInfo({ attempt: 1, message: "429", next: 0 }).retryAt).toBeUndefined();
    expect(
      openCodeRetryInfo({ attempt: 1, message: "429", next: Number.NaN }).retryAt,
    ).toBeUndefined();
  });

  it("drops an empty reason and caps a long one", () => {
    expect(openCodeRetryInfo({ attempt: 0, message: "  ", next: NEXT })).not.toHaveProperty(
      "reason",
    );
    expect(
      openCodeRetryInfo({ attempt: 0, message: "x".repeat(500), next: NEXT }).reason,
    ).toHaveLength(200);
  });
});
