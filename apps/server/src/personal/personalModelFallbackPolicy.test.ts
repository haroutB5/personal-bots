import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { primaryUsageRecovered, type SwitchBackInput } from "./personalModelFallbackPolicy.ts";

const home: ModelSelection = {
  instanceId: "claude" as ModelSelection["instanceId"],
  model: "opus",
};

const reading: NonNullable<ServerProvider["usageLimits"]> = {
  checkedAt: "2026-09-03T12:00:00.000Z",
  fullReadAt: "2026-09-03T12:00:00.000Z",
  windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
};

const input: SwitchBackInput = {
  killSwitchOn: true,
  botFallbackEnabled: true,
  nowMs: Date.parse("2026-09-03T12:00:01.000Z"),
  startedAtMs: Date.parse("2026-09-03T11:00:00.000Z"),
  resetAtMs: null,
  home,
  homeProvider: { usageLimits: reading },
  freshAfterMs: Date.parse("2026-09-03T11:59:00.000Z"),
  idle: true,
  recoveryProviderReady: true,
  limitReason: "session",
};

describe("primaryUsageRecovered", () => {
  it("recovers on a fresh full reading with room on the limited pool", () => {
    expect(primaryUsageRecovered(input)).toBe(true);
  });

  it("does not recover on a reading whose refresh failed", () => {
    expect(
      primaryUsageRecovered({
        ...input,
        homeProvider: {
          usageLimits: {
            ...reading,
            refreshFailed: { at: "2026-09-03T12:00:00.500Z", message: "probe timed out" },
          },
        },
      }),
    ).toBe(false);
  });
});
