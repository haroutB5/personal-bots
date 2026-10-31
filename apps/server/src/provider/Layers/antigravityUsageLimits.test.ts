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

  it("splits per-model Gemini session and Gemini 4 Argon weekly quotas and keeps 5h+2s clock skew on session (31 Oct 2026 live shape)", () => {
    const proCheckedAt = "2026-10-31T11:38:15.246Z";
    const proModels = {
      models: {
        // 5 hours + 2 seconds past checkedAt (server clock stamped after HTTP round-trip)
        "gemini-3.8-flash-medium": {
          quotaInfo: { remainingFraction: 1, resetTime: "2026-10-31T16:38:17Z" },
        },
        "gemini-4-argon-medium": {
          quotaInfo: { remainingFraction: 0.61065227, resetTime: "2026-11-07T10:54:16Z" },
        },
        "gemini-4-argon-high": {
          quotaInfo: { remainingFraction: 0.61065227, resetTime: "2026-11-07T10:54:16Z" },
        },
      },
    };
    const proSummary = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-weekly",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-11-07T11:38:17Z",
            },
            {
              bucketId: "gemini-5h",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-31T16:38:17Z",
            },
          ],
        },
        {
          displayName: "Gemini 4 Argon",
          buckets: [
            {
              bucketId: "gemini-argon-wtu-weekly",
              displayName: "Gemini 4 Argon Weekly Limit",
              window: "weekly",
              remainingFraction: 0.61065227,
              resetTime: "2026-11-07T10:54:16Z",
            },
          ],
        },
      ],
    };

    const limits = antigravityUsageToLimits(proModels, proSummary, proCheckedAt);
    expect(limits.windows).toEqual([
      {
        id: "gemini-session",
        kind: "session",
        label: "Gemini · 5-hour session",
        usedPercent: 0,
        resetsAt: "2026-10-31T16:38:17Z",
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 39,
        resetsAt: "2026-11-07T10:54:16Z",
      },
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

  it("picks the tightest weekly bucket across Gemini Models and Gemini 4 Argon groups", () => {
    const limits = antigravityQuotaSummaryToLimits(
      {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-5h",
                window: "5h",
                remainingFraction: 1,
                resetTime: "2026-10-31T16:43:43Z",
              },
              {
                bucketId: "gemini-weekly",
                window: "weekly",
                remainingFraction: 1,
                resetTime: "2026-11-07T11:43:43Z",
              },
            ],
          },
          {
            displayName: "Gemini 4 Argon",
            buckets: [
              {
                bucketId: "gemini-argon-wtu-weekly",
                displayName: "Gemini 4 Argon Weekly Limit",
                window: "weekly",
                remainingFraction: 0.61,
                resetTime: "2026-11-07T10:54:16Z",
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
        usedPercent: 0,
        resetsAt: "2026-10-31T16:43:43Z",
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 39,
        resetsAt: "2026-11-07T10:54:16Z",
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

  describe("a spent Gemini quota (21 Oct 2026 live shape)", () => {
    const checkedAt = "2026-10-21T20:05:00.000Z";
    const nowMs = Date.parse(checkedAt);

    it("reads a model with a reset but no remainingFraction as spent, on the weekly window", () => {
      const limits = antigravityUsageToLimits(
        {
          models: {
            "gemini-3-flash": { quotaInfo: { resetTime: "2026-10-26T20:56:06Z" } },
            "gemini-2.5-pro": { quotaInfo: { resetTime: "2026-10-26T20:56:06Z" } },
            "claude-opus": { quotaInfo: { remainingFraction: 1 } },
          },
        },
        null,
        checkedAt,
      );
      expect(limits.windows).toEqual([
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini · Weekly",
          usedPercent: 100,
          resetsAt: "2026-10-26T20:56:06Z",
        },
      ]);
    });

    it("keeps a reset within five hours on the session window", () => {
      const limits = antigravityUsageToLimits(
        {
          models: {
            "gemini-3-flash": {
              quotaInfo: { remainingFraction: 0.81, resetTime: "2026-10-21T23:00:00Z" },
            },
          },
        },
        null,
        checkedAt,
      );
      expect(limits.windows[0]).toMatchObject({ id: "gemini-session", usedPercent: 19 });
    });

    it("files a notice with a 5-day reset under the weekly window, for its five trusted hours", () => {
      const read = makeUsageLimits({ checkedAt, windows: [] });
      const hit = {
        retryAt: "2026-10-26T22:05:00.000Z",
        expiresAt: "2026-10-22T01:05:00.000Z",
      };
      const out = withAntigravityQuotaHit(read, hit, nowMs);
      expect(out.windows).toEqual([
        {
          id: "gemini-weekly",
          kind: "weekly",
          label: "Gemini · Weekly",
          usedPercent: 100,
          resetsAt: "2026-10-26T22:05:00.000Z",
        },
      ]);
      expect(withAntigravityQuotaHit(read, hit, Date.parse("2026-10-22T01:06:00.000Z"))).toBe(read);
    });
  });
});
