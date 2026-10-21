import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  antigravityQuotaSummaryToLimits,
  antigravityUsageToLimits,
  readAntigravityUsageLimits,
  withAntigravityQuotaHit,
} from "./antigravityUsageLimits.ts";
import { makeUnavailableUsageLimits, makeUsageLimits } from "../providerUsageLimits.ts";

const CHECKED_AT = "2026-10-20T17:00:00.000Z";
const TestServicesLayer = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

describe("antigravityUsageToLimits", () => {
  const checkedAt = "2026-10-21T11:24:00.000Z";
  // Shapes seen live on 21 Oct 2026: the summary said untouched while the
  // per-model list showed real use.
  const untouchedSummary = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          {
            bucketId: "gemini-weekly",
            window: "weekly",
            remainingFraction: 1,
            resetTime: "2026-10-28T11:24:03Z",
          },
          {
            bucketId: "gemini-5h",
            window: "5h",
            remainingFraction: 1,
            resetTime: "2026-10-21T16:24:03Z",
          },
        ],
      },
    ],
  };
  const models = {
    models: {
      "gemini-3.8-flash-tiered": {
        quotaInfo: { remainingFraction: 0.81310505, resetTime: "2026-10-21T15:27:04Z" },
      },
      "gemini-2.5-pro": {
        quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-21T15:27:04Z" },
      },
      "claude-sonnet": { quotaInfo: { remainingFraction: 0.1 } },
    },
  };

  it("takes the session from the tightest Gemini model, not the summary", () => {
    const limits = antigravityUsageToLimits(models, untouchedSummary, checkedAt);
    expect(limits.windows).toEqual([
      expect.objectContaining({
        id: "gemini-session",
        usedPercent: 19,
        resetsAt: "2026-10-21T15:27:04Z",
      }),
    ]);
  });

  it("adds the summary's weekly window only once it shows use", () => {
    const used = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              window: "weekly",
              remainingFraction: 0.6,
              resetTime: "2026-10-28T11:24:03Z",
            },
          ],
        },
      ],
    };
    const limits = antigravityUsageToLimits(models, used, checkedAt);
    expect(limits.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ["gemini-session", 19],
      ["gemini-weekly", 40],
    ]);
  });

  it("falls back to the summary when the per-model list has no Gemini data", () => {
    const limits = antigravityUsageToLimits(null, untouchedSummary, checkedAt);
    expect(limits.windows.map((w) => w.id)).toEqual(["gemini-session", "gemini-weekly"]);
    expect(antigravityUsageToLimits(null, null, checkedAt).unavailable?.reason).toBe("unsupported");
  });
});

describe("antigravityQuotaSummaryToLimits", () => {
  it("maps Gemini and Claude & GPT groups to session and weekly windows", () => {
    const limits = antigravityQuotaSummaryToLimits(
      {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-5h",
                displayName: "Five Hour Limit Remaining",
                window: "5h",
                remainingFraction: 0.79,
                resetTime: "2026-10-21T01:00:00Z",
              },
              {
                bucketId: "gemini-weekly",
                displayName: "Weekly Limit Remaining",
                window: "weekly",
                remainingFraction: 0.42,
                resetTime: "2026-10-27T20:00:00Z",
              },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              {
                bucketId: "3p-5h",
                displayName: "Five Hour Limit Remaining",
                window: "5h",
                remainingFraction: 1,
                resetTime: "2026-10-21T01:00:00Z",
              },
              {
                bucketId: "3p-weekly",
                displayName: "Weekly Limit Remaining",
                window: "weekly",
                remainingFraction: 0.95,
                resetTime: "2026-10-27T20:00:00Z",
              },
            ],
          },
        ],
      },
      CHECKED_AT,
    );

    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "gemini-session",
        kind: "session",
        label: "Gemini · 5-hour session",
        usedPercent: 21,
        resetsAt: "2026-10-21T01:00:00Z",
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 58,
        resetsAt: "2026-10-27T20:00:00Z",
      },
    ]);
  });

  it("handles accounts with Gemini only and missing weekly bucket", () => {
    const limits = antigravityQuotaSummaryToLimits(
      {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-5h",
                displayName: "Five Hour Limit Remaining",
                window: "5h",
                remainingFraction: 0.65,
                resetTime: "2026-10-21T02:00:00Z",
              },
            ],
          },
        ],
      },
      CHECKED_AT,
    );

    expect(limits.windows).toEqual([
      {
        id: "gemini-session",
        kind: "session",
        label: "Gemini · 5-hour session",
        usedPercent: 35,
        resetsAt: "2026-10-21T02:00:00Z",
      },
    ]);
  });

  it("returns unsupported when response contains no groups with valid quota", () => {
    const limits = antigravityQuotaSummaryToLimits(
      {
        groups: [],
      },
      CHECKED_AT,
    );

    expect(limits.windows).toHaveLength(0);
    expect(limits.unavailable?.reason).toBe("unsupported");
  });
});

it.layer(TestServicesLayer)("readAntigravityUsageLimits", (it) => {
  it.effect("returns unsupported when disabled", () =>
    Effect.gen(function* () {
      const result = yield* readAntigravityUsageLimits({
        profileDirectory: "C:/unused",
        enabled: false,
      });
      expect(result.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("returns unsupported for non-personal auth methods", () =>
    Effect.gen(function* () {
      const result = yield* readAntigravityUsageLimits({
        profileDirectory: "C:/unused",
        authMethod: "gemini-api-key",
      });
      expect(result.unavailable?.reason).toBe("unsupported");
    }),
  );

  describe("withAntigravityQuotaHit", () => {
    const now = Date.parse("2026-10-20T23:00:00.000Z");
    const read = makeUsageLimits({
      checkedAt: "2026-10-20T23:00:00.000Z",
      windows: [
        { id: "gemini-session", kind: "session", label: "Gemini · 5-hour session", usedPercent: 0 },
        { id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly", usedPercent: 0 },
      ],
    });

    it("marks the session window spent until the notice's reset", () => {
      const out = withAntigravityQuotaHit(
        read,
        { retryAt: "2026-10-21T02:15:00.000Z", group: "gemini" },
        now,
      );
      expect(out.windows.find((w) => w.id === "gemini-session")).toMatchObject({
        usedPercent: 100,
        resetsAt: "2026-10-21T02:15:00.000Z",
      });
      expect(out.windows.find((w) => w.id === "gemini-weekly")?.usedPercent).toBe(0);
    });

    it("a reset beyond five hours is the weekly window", () => {
      const out = withAntigravityQuotaHit(
        read,
        { retryAt: "2026-10-23T23:00:00.000Z", group: "gemini" },
        now,
      );
      expect(out.windows.find((w) => w.id === "gemini-weekly")?.usedPercent).toBe(100);
      expect(out.windows.find((w) => w.id === "gemini-session")?.usedPercent).toBe(0);
    });

    it("adds the window when the summary had none, and ignores a passed reset", () => {
      const empty = makeUnavailableUsageLimits({
        checkedAt: read.checkedAt,
        reason: "unsupported",
      });
      const added = withAntigravityQuotaHit(empty, { retryAt: "2026-10-21T01:00:00.000Z" }, now);
      expect(added.windows).toEqual([
        expect.objectContaining({ id: "gemini-session", usedPercent: 100 }),
      ]);
      expect(withAntigravityQuotaHit(read, { retryAt: "2026-10-20T22:00:00.000Z" }, now)).toBe(
        read,
      );
      expect(withAntigravityQuotaHit(read, undefined, now)).toBe(read);
    });
  });
});
