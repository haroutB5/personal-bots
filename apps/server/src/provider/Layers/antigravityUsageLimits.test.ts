import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  antigravityQuotaSummaryToLimits,
  readAntigravityUsageLimits,
} from "./antigravityUsageLimits.ts";

const CHECKED_AT = "2026-10-20T17:00:00.000Z";
const TestServicesLayer = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

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
        id: "z-claude-gpt-session",
        kind: "session",
        label: "Claude & GPT · 5-hour session",
        usedPercent: 0,
        resetsAt: "2026-10-21T01:00:00Z",
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 58,
        resetsAt: "2026-10-27T20:00:00Z",
      },
      {
        id: "z-claude-gpt-weekly",
        kind: "weekly",
        label: "Claude & GPT · Weekly",
        usedPercent: 5,
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
});
