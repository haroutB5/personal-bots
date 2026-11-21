import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  primaryUsageRecovered,
  type SwitchBackInput,
  usageRoom,
} from "./personalModelFallbackPolicy.ts";

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

describe("usageRoom", () => {
  const fableSpent: NonNullable<ServerProvider["usageLimits"]> = {
    checkedAt: "2026-11-14T13:44:58.102Z",
    windows: [
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 73 },
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        usedPercent: 100,
        resetsAt: "2026-11-15T11:00:00.000Z",
      },
    ],
  };
  const nowMs = Date.parse("2026-11-14T13:45:00.000Z");

  it("leaves room for another model when only one model's weekly allowance is spent", () => {
    expect(usageRoom(fableSpent, "claude-opus-5-5", nowMs)).toEqual({
      room: true,
      known: true,
      resetsAtMs: null,
    });
  });

  it("finds no room for the model whose weekly allowance is spent", () => {
    expect(usageRoom(fableSpent, "claude-fable-5-2", nowMs)).toEqual({
      room: false,
      known: true,
      resetsAtMs: Date.parse("2026-11-15T11:00:00.000Z"),
    });
  });

  it("does not let Antigravity 3p windows block Gemini models", () => {
    const agy3pSpent: NonNullable<ServerProvider["usageLimits"]> = {
      checkedAt: "2026-11-14T13:44:58.102Z",
      windows: [
        { id: "gemini-weekly", kind: "weekly", label: "Gemini weekly", usedPercent: 20 },
        {
          id: "3p-weekly",
          kind: "weekly",
          label: "Claude & GPT (shared)",
          usedPercent: 100,
          resetsAt: "2026-11-15T11:00:00.000Z",
        },
      ],
    };
    expect(usageRoom(agy3pSpent, "gemini-4-neon", nowMs)).toEqual({
      room: true,
      known: true,
      resetsAtMs: null,
    });
    expect(usageRoom(agy3pSpent, "claude-sonnet-4-6", nowMs)).toEqual({
      room: false,
      known: true,
      resetsAtMs: Date.parse("2026-11-15T11:00:00.000Z"),
    });
  });
});
