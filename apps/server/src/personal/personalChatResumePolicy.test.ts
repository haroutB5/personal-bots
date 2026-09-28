import { describe, expect, it } from "@effect/vitest";

import {
  decideLimitHit,
  formatResumeTime,
  limitWord,
  PERSONAL_CHAT_RESUME_GRACE_MS,
  PERSONAL_CHAT_RESUME_MAX_CONSECUTIVE,
  providerLabel,
} from "./personalChatResumePolicy.ts";

const NOW = Date.parse("2026-09-27T19:42:36.000Z");

describe("decideLimitHit", () => {
  it("continues just after a reported reset", () => {
    expect(
      decideLimitHit({
        retry: { retryAt: "2026-09-27T22:00:00.000Z" },
        nowMs: NOW,
        consecutiveResumes: 0,
      }),
    ).toEqual({
      kind: "schedule",
      resumeAtMs: Date.parse("2026-09-27T22:00:00.000Z") + PERSONAL_CHAT_RESUME_GRACE_MS,
    });
  });

  it("continues soon when the reported reset has already passed", () => {
    expect(
      decideLimitHit({
        retry: { retryAt: "2026-09-27T19:00:00.000Z" },
        nowMs: NOW,
        consecutiveResumes: 0,
      }),
    ).toEqual({ kind: "schedule", resumeAtMs: NOW + PERSONAL_CHAT_RESUME_GRACE_MS });
  });

  it("only shows the notice without a believable reset, or after repeated continues", () => {
    expect(decideLimitHit({ retry: {}, nowMs: NOW, consecutiveResumes: 0 })).toEqual({
      kind: "notice_only",
      reason: "no_reset",
    });
    expect(
      decideLimitHit({
        retry: { retryAt: "2026-11-01T00:00:00.000Z" },
        nowMs: NOW,
        consecutiveResumes: 0,
      }),
    ).toEqual({ kind: "notice_only", reason: "reset_too_far" });
    expect(
      decideLimitHit({
        retry: { retryAt: "2026-09-27T22:00:00.000Z" },
        nowMs: NOW,
        consecutiveResumes: PERSONAL_CHAT_RESUME_MAX_CONSECUTIVE,
      }),
    ).toEqual({ kind: "notice_only", reason: "too_many_resumes" });
  });
});

describe("notice wording", () => {
  it("shows London time, with the day when it is not today", () => {
    expect(formatResumeTime(Date.parse("2026-09-27T22:00:00.000Z"), NOW)).toBe("23:00");
    expect(formatResumeTime(Date.parse("2026-09-29T08:00:00.000Z"), NOW)).toBe("Tue 09:00");
  });

  it("names the provider and the kind of limit", () => {
    expect(providerLabel("claudeAgent")).toBe("Claude");
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerLabel("someNewProvider")).toBe("someNewProvider");
    expect(limitWord("five_hour")).toBe("usage limit");
    expect(limitWord("seven_day_opus")).toBe("usage limit");
    expect(limitWord("usageLimitExceeded")).toBe("usage limit");
    expect(limitWord("HTTP 429 rate_limit_error")).toBe("rate limit");
  });
});
