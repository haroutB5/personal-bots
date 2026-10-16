// @effect-diagnostics globalDate:off - local-time dates, as Codex prints them.
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  isUsageLimitFailure,
  limitResetFromText,
  smokeLimitDueAtMs,
  smokeLimitResetMs,
  smokeLimitRetryAtMs,
} from "./smokeLimit.ts";

const CODEX = ProviderInstanceId.make("codex");
// Local-time dates throughout: Codex prints its "try again at" in the machine's time zone.
const local = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime();

describe("isUsageLimitFailure", () => {
  it("reads each provider's out-of-usage words", () => {
    for (const text of [
      "ERROR: You've hit your usage limit. Upgrade to Pro or try again at Oct 16th, 2026 12:47 AM.",
      "You've hit your limit · resets 3pm (Europe/London)",
      "Claude usage limit reached. Your limit will reset at 3pm.",
      "5-hour limit reached",
      "Credit balance is too low",
      "Insufficient Balance",
      "insufficient_balance",
      "You exceeded your current quota, please check your plan and billing details.",
      "429 Too Many Requests",
      "Rate limit exceeded",
      "You are out of extra usage",
    ]) {
      assert.isTrue(isUsageLimitFailure(text), text);
    }
  });

  it("leaves real breakage alone", () => {
    for (const text of [
      "API Error: 500",
      "Unexpected server error.",
      "Codex could not start: spawn codex ENOENT",
      "Claude Code did not reply within 3 minutes.",
      "Codex replied with an empty message.",
      "unknown option '--bogus' (version 0.429.1, port 4290)",
    ]) {
      assert.isFalse(isUsageLimitFailure(text), text);
    }
  });
});

describe("limitResetFromText", () => {
  it("reads Codex's dated 'try again at'", () => {
    assert.strictEqual(
      limitResetFromText(
        "You've hit your usage limit. Visit settings or try again at Oct 16th, 2026 12:47 AM.",
        local(2026, 9, 15, 23, 0),
      ),
      local(2026, 9, 16, 0, 47),
    );
    assert.strictEqual(
      limitResetFromText("try again at Nov 2nd, 2026 12:05 PM", local(2026, 9, 15, 23, 0)),
      local(2026, 10, 2, 12, 5),
    );
    assert.strictEqual(
      limitResetFromText("try again at Oct 3rd, 2026 11:30 PM", local(2026, 9, 1, 9, 0)),
      local(2026, 9, 3, 23, 30),
    );
  });

  it("reads a bare time as the next such time, and a relative wait", () => {
    assert.strictEqual(
      limitResetFromText("try again at 2:47 PM", local(2026, 9, 16, 9, 0)),
      local(2026, 9, 16, 14, 47),
    );
    assert.strictEqual(
      limitResetFromText("try again at 9:15 AM", local(2026, 9, 16, 20, 0)),
      local(2026, 9, 17, 9, 15),
    );
    const base = local(2026, 9, 16, 9, 0);
    assert.strictEqual(
      limitResetFromText("Try again in 2 days 3 hours 4 minutes", base),
      base + (2 * 24 * 60 + 3 * 60 + 4) * 60_000,
    );
    assert.strictEqual(limitResetFromText("try again in 5 minutes.", base), base + 5 * 60_000);
  });

  it("says nothing when the text names no time", () => {
    assert.isNull(limitResetFromText("You've hit your usage limit.", 0));
    assert.isNull(limitResetFromText("try again at Foo 3rd, 2026 1:00 PM", 0));
    assert.isNull(limitResetFromText("try again at 13:00 PM", 0));
  });
});

describe("smokeLimitResetMs", () => {
  const now = local(2026, 9, 16, 8, 52);
  const base = {
    instanceId: CODEX,
    provider: {} as Pick<ServerProvider, "usageLimits">,
    nowMs: now,
    failedAtMs: now,
  };
  const failure = (detail: string, model = "gpt-6-astra") => ({ model, detail });

  it("takes the error's time, and ignores a past one for a fresh failure", () => {
    const named = failure("hit your usage limit, try again at Oct 16th, 2026 11:47 PM");
    assert.strictEqual(
      smokeLimitResetMs({ ...base, failures: [named], allowPast: false }),
      local(2026, 9, 16, 23, 47),
    );
    const past = failure("hit your usage limit, try again at Oct 16th, 2026 12:47 AM");
    assert.isNull(smokeLimitResetMs({ ...base, failures: [past], allowPast: false }));
    assert.strictEqual(
      smokeLimitResetMs({ ...base, failures: [past], allowPast: true }),
      local(2026, 9, 16, 0, 47),
    );
  });

  it("falls to the provider's spent usage window, and the earliest reset wins", () => {
    const resetsAt = new Date(local(2026, 9, 16, 13, 0)).toISOString();
    const provider = {
      usageLimits: {
        checkedAt: new Date(now).toISOString(),
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "5 hour",
            usedPercent: 100,
            resetsAt,
          },
        ],
      },
    } as unknown as Pick<ServerProvider, "usageLimits">;
    assert.strictEqual(
      smokeLimitResetMs({
        ...base,
        provider,
        failures: [failure("You've hit your usage limit.")],
        allowPast: false,
      }),
      Date.parse(resetsAt),
    );
    assert.strictEqual(
      smokeLimitResetMs({
        ...base,
        provider,
        failures: [
          failure("hit your usage limit, try again at Oct 16th, 2026 11:47 PM", "a"),
          failure("You've hit your usage limit.", "b"),
        ],
        allowPast: false,
      }),
      Date.parse(resetsAt),
    );
  });

  it("is null when nothing says, which becomes a 30 minute wait", () => {
    assert.isNull(
      smokeLimitResetMs({
        ...base,
        failures: [failure("You've hit your usage limit.")],
        allowPast: false,
      }),
    );
    // The retry runs 30 minutes out: the stored time plus the one-minute grace.
    assert.strictEqual(smokeLimitDueAtMs(smokeLimitRetryAtMs(null, now)), now + 30 * 60_000);
    assert.strictEqual(
      smokeLimitDueAtMs(smokeLimitRetryAtMs(now + 5 * 60_000, now)),
      now + 6 * 60_000,
    );
  });
});
