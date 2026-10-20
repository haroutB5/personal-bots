import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  antigravityAvailableModelsToLimits,
  readAntigravityUsageLimits,
} from "./antigravityUsageLimits.ts";

const CHECKED_AT = "2026-10-20T17:00:00.000Z";
const TestServicesLayer = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

describe("antigravityAvailableModelsToLimits", () => {
  it("maps Gemini models to Gemini window and Claude models to Claude window", () => {
    const limits = antigravityAvailableModelsToLimits(
      {
        models: {
          "gemini-3.8-flash-tiered": {
            displayName: "Gemini 3.8 Flash",
            quotaInfo: {
              remainingFraction: 0.92,
              resetTime: "2026-10-20T21:00:00Z",
            },
          },
          "claude-sonnet-5-5-high": {
            displayName: "Claude Sonnet 5.5",
            quotaInfo: {
              remainingFraction: 1,
              resetTime: "2026-10-20T21:30:00Z",
            },
          },
        },
      },
      CHECKED_AT,
    );

    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "claude",
        kind: "session",
        label: "Claude",
        usedPercent: 0,
        resetsAt: "2026-10-20T21:30:00Z",
      },
      {
        id: "gemini",
        kind: "session",
        label: "Gemini",
        usedPercent: 8,
        resetsAt: "2026-10-20T21:00:00Z",
      },
    ]);
  });

  it("prefers tightest active Gemini model", () => {
    const limits = antigravityAvailableModelsToLimits(
      {
        models: {
          "gemini-4-argon-high": {
            displayName: "Gemini 4 Argon",
            quotaInfo: {
              remainingFraction: 0.6,
              resetTime: "2026-10-20T22:00:00Z",
            },
          },
          "gemini-3.8-flash-tiered": {
            displayName: "Gemini 3.8 Flash",
            quotaInfo: {
              remainingFraction: 0.8,
              resetTime: "2026-10-20T21:00:00Z",
            },
          },
        },
      },
      CHECKED_AT,
    );

    expect(limits.windows).toHaveLength(1);
    expect(limits.windows[0]).toEqual({
      id: "gemini",
      kind: "session",
      label: "Gemini",
      usedPercent: 40,
      resetsAt: "2026-10-20T22:00:00Z",
    });
  });

  it("returns unsupported when response contains no models with quotaInfo", () => {
    const limits = antigravityAvailableModelsToLimits(
      {
        models: {
          chat_123: { displayName: "Chat" },
        },
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
