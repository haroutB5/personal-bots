import { describe, expect, it } from "vite-plus/test";

import { claudeApiRetryInfo, claudeRateLimitRejectionInfo } from "./claudeRetryInfo.ts";

describe("claudeApiRetryInfo", () => {
  it("dates a 429 retry from when it was observed (live payload, 2026-09-13)", () => {
    expect(
      claudeApiRetryInfo(
        {
          attempt: 1,
          max_retries: 300,
          retry_delay_ms: 21_600_000,
          error_status: 429,
          error: "rate_limit",
        },
        "2026-09-13T03:47:16.087Z",
      ),
    ).toEqual({
      kind: "rate_limited",
      retryAt: "2026-09-13T09:47:16.087Z",
      attempt: 1,
      maxAttempts: 300,
      reason: "HTTP 429 rate_limit",
    });
  });

  it("keeps the same retryAt as the heartbeat's delay shrinks", () => {
    const later = claudeApiRetryInfo(
      { attempt: 1, max_retries: 300, retry_delay_ms: 21_570_000, error_status: 429 },
      "2026-09-13T03:47:46.087Z",
    );
    expect(later.retryAt).toBe("2026-09-13T09:47:16.087Z");
  });

  it("treats other failures as transport retries", () => {
    expect(
      claudeApiRetryInfo(
        {
          attempt: 3,
          max_retries: 10,
          retry_delay_ms: 1000,
          error_status: 502,
          error: { type: "api_error" },
        },
        "2026-01-01T00:00:00.000Z",
      ),
    ).toEqual({
      kind: "retrying",
      retryAt: "2026-01-01T00:00:01.000Z",
      attempt: 3,
      maxAttempts: 10,
      reason: "HTTP 502 api_error",
    });
  });

  it("recognises a rate limit by name when there was no HTTP response", () => {
    const info = claudeApiRetryInfo(
      {
        attempt: 1,
        max_retries: 1,
        retry_delay_ms: 0,
        error_status: null,
        error: { type: "rate_limit_error" },
      },
      "2026-01-01T00:00:00.000Z",
    );
    expect(info.kind).toBe("rate_limited");
    expect(info.reason).toBe("rate_limit_error");
  });

  it("leaves retryAt unset when no usable delay was reported", () => {
    const info = claudeApiRetryInfo(
      { attempt: 1, max_retries: 5, retry_delay_ms: Number.NaN, error_status: 429 },
      "2026-01-01T00:00:00.000Z",
    );
    expect(info.kind).toBe("rate_limited");
    expect(info.retryAt).toBeUndefined();
  });
});

describe("claudeRateLimitRejectionInfo", () => {
  it("uses the window's reported reset", () => {
    expect(
      claudeRateLimitRejectionInfo({
        status: "rejected",
        resetsAt: 1_789_300_000,
        rateLimitType: "five_hour",
      }),
    ).toEqual({
      kind: "rate_limited",
      retryAt: "2026-09-13T11:46:40.000Z",
      reason: "five_hour",
    });
  });

  it("says nothing about the reset when none was reported", () => {
    expect(claudeRateLimitRejectionInfo({ status: "rejected" })).toEqual({ kind: "rate_limited" });
  });
});
