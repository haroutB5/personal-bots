import type { PersonalBot, ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { pickUsageWindows, usageFallbackBots, usageStatusReading } from "./usageStatus.ts";

const window = (
  overrides: Partial<ServerProviderUsageWindow> & Pick<ServerProviderUsageWindow, "id">,
): ServerProviderUsageWindow =>
  ({
    kind: "other",
    label: overrides.id,
    usedPercent: 10,
    ...overrides,
  }) as ServerProviderUsageWindow;

const provider = (
  overrides: { readonly instanceId: string; readonly driver: string } & Record<string, unknown>,
): ServerProvider =>
  ({
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-17T22:00:00.000Z",
    models: [],
    ...overrides,
  }) as unknown as ServerProvider;

const bot = (
  overrides: { readonly botId: string; readonly name: string } & Record<string, unknown>,
): PersonalBot =>
  ({
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    enabled: true,
    sortOrder: 0,
    ...overrides,
  }) as unknown as PersonalBot;

describe("usage_status readings", () => {
  it("takes the session and every weekly window with its reset time", () => {
    const picked = pickUsageWindows([
      window({
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 26,
        resetsAt: "2026-10-17T23:00:00.000Z",
      }),
      window({
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 8,
        resetsAt: "2026-10-20T00:00:00.000Z",
      }),
      window({ id: "seven_day_fable", kind: "weekly", label: "Weekly (Fable)", usedPercent: 3 }),
    ]);
    expect(picked.session).toEqual({
      id: "five_hour",
      label: "Session",
      usedPercent: 26,
      resetsAt: "2026-10-17T23:00:00.000Z",
    });
    expect(picked.weekly.map((row) => [row.id, row.usedPercent, row.resetsAt])).toEqual([
      ["seven_day", 8, "2026-10-20T00:00:00.000Z"],
      ["seven_day_fable", 3, null],
    ]);
  });

  it("falls back to the five-hour and seven-day ids when kinds are not set, without duplicates", () => {
    const picked = pickUsageWindows([
      window({ id: "five_hour", usedPercent: 12 }),
      window({ id: "seven_day", usedPercent: 40 }),
      window({ id: "seven_day", usedPercent: 40 }),
    ]);
    expect(picked.session?.id).toBe("five_hour");
    expect(picked.weekly.map((row) => row.id)).toEqual(["seven_day"]);
  });

  it("returns one reading per enabled, installed provider, with the reason it has no figures", () => {
    const reading = usageStatusReading({
      readAt: "2026-10-17T22:05:00.000Z",
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude",
          usageLimits: {
            checkedAt: "2026-10-17T22:00:00.000Z",
            windows: [window({ id: "five_hour", kind: "session", usedPercent: 26 })],
          },
        }),
        provider({
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          usageLimits: {
            checkedAt: "2026-10-17T21:55:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed", message: "Codex did not answer." },
          },
        }),
        provider({ instanceId: "off", driver: "codex", enabled: false }),
        provider({ instanceId: "missing", driver: "codex", installed: false }),
      ],
      bots: [],
    });
    expect(reading.readAt).toBe("2026-10-17T22:05:00.000Z");
    expect(reading.providers.map((row) => [row.instanceId, row.name])).toEqual([
      ["claudeAgent", "Claude"],
      ["codex", "Codex"],
    ]);
    expect(reading.providers[0]!.session?.usedPercent).toBe(26);
    expect(reading.providers[1]!.unavailable).toBe("Codex did not answer.");
    expect(reading.providers[1]!.session).toBeNull();
  });

  it("lists every bot on a fallback, peak or scheduled model with its active model", () => {
    const bots = usageFallbackBots([
      bot({
        botId: "cto",
        name: "CTO",
        fallbackActive: {
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
          since: "2026-10-17T21:00:00.000Z",
          resetAt: "2026-10-17T23:00:00.000Z",
          fromProvider: "Claude",
        },
      }),
      bot({
        botId: "frontend",
        name: "Frontend",
        fallbackActive: {
          modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
          since: "2026-10-17T06:00:00.000Z",
          resetAt: "2026-10-17T10:00:00.000Z",
          fromProvider: "DeepSeek",
          reason: "deepseek_peak",
        },
      }),
      bot({
        botId: "qa",
        name: "QA",
        fallbackActive: {
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
          since: "2026-10-17T20:00:00.000Z",
          fromProvider: "Claude",
          reason: "schedule",
        },
      }),
      bot({ botId: "ops", name: "DevOps" }),
    ]);
    expect(bots.map((row) => [row.botName, row.reason, row.activeModel])).toEqual([
      ["CTO", "usage_limit", "gpt-6.1-sol"],
      ["Frontend", "deepseek_peak", "claude-sonnet-5-5"],
      ["QA", "schedule", "gpt-6.1-sol"],
    ]);
    expect(bots[0]!.resetAt).toBe("2026-10-17T23:00:00.000Z");
    expect(bots[2]!.fromProvider).toBe("Claude");
  });
});
