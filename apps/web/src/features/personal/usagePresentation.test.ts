import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatResetCountdown, selectUsageCards } from "./usagePresentation";

const NOW = Date.parse("2026-09-13T12:00:00Z");

function window(
  overrides: Partial<ServerProviderUsageWindow> & Pick<ServerProviderUsageWindow, "id">,
): ServerProviderUsageWindow {
  return {
    kind: "session",
    label: "Session",
    usedPercent: 10,
    ...overrides,
  };
}

function provider(
  overrides: Omit<Partial<ServerProvider>, "driver" | "instanceId"> & {
    driver: string;
    instanceId: string;
  },
): ServerProvider {
  const { driver, instanceId, ...rest } = overrides;
  return {
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...rest,
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(instanceId),
  } as ServerProvider;
}

const CLAUDE_WINDOWS: ServerProviderUsageWindow[] = [
  window({
    id: "five_hour",
    kind: "session",
    label: "5-hour session",
    usedPercent: 42,
    resetsAt: "2026-09-13T14:30:00Z",
    windowDurationMins: 300,
  }),
  window({
    id: "seven_day_opus",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 17,
    resetsAt: "2026-09-20T12:00:00Z",
  }),
];

function claudeLimits(windows: ServerProviderUsageWindow[] = CLAUDE_WINDOWS) {
  return { checkedAt: "2026-09-13T11:59:00Z", windows };
}

describe("formatResetCountdown", () => {
  it("counts down in hours and minutes", () => {
    expect(formatResetCountdown("2026-09-13T14:30:00Z", NOW)).toBe("resets in 2h 30m");
  });

  it("counts down in days past 48 hours", () => {
    expect(formatResetCountdown("2026-09-20T12:00:00Z", NOW)).toBe("resets in 7d 0h");
  });

  it("reads a passed reset as now and unknown resets as null", () => {
    expect(formatResetCountdown("2026-09-13T11:00:00Z", NOW)).toBe("resets now");
    expect(formatResetCountdown(undefined, NOW)).toBeNull();
    expect(formatResetCountdown("not-a-date", NOW)).toBeNull();
  });
});

describe("selectUsageCards", () => {
  it("builds Claude and GPT cards with session and weekly rows", () => {
    const cards = selectUsageCards(
      [
        provider({ driver: "claudeAgent", instanceId: "claudeAgent", usageLimits: claudeLimits() }),
        provider({
          driver: "codex",
          instanceId: "codex",
          auth: { status: "authenticated", label: "ChatGPT Plus" },
          usageLimits: {
            checkedAt: "2026-09-13T11:58:00Z",
            windows: [
              window({
                id: "primary",
                kind: "session",
                label: "5-hour",
                usedPercent: 63,
                resetsAt: "2026-09-13T12:45:00Z",
                windowDurationMins: 300,
              }),
              window({
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 5,
                resetsAt: "2026-09-20T12:00:00Z",
              }),
            ],
          },
        }),
      ],
      NOW,
    );
    expect(cards.map((card) => card.title)).toEqual(["Claude", "GPT"]);
    const [claude, gpt] = cards;
    expect(claude!.status).toBe("ready");
    expect(claude!.session).toMatchObject({ usedPercent: 42, resetLabel: "resets in 2h 30m" });
    expect(claude!.weeklies).toHaveLength(1);
    expect(claude!.weeklies[0]).toMatchObject({ usedPercent: 17, resetLabel: "resets in 7d 0h" });
    expect(gpt!.plan).toBe("ChatGPT Plus");
    expect(gpt!.session).toMatchObject({ usedPercent: 63, resetLabel: "resets in 45m" });
  });

  it("marks API-key accounts unavailable instead of zeroing the bars", () => {
    const cards = selectUsageCards(
      [
        provider({
          driver: "claudeAgent",
          instanceId: "claudeAgent",
          usageLimits: {
            checkedAt: "2026-09-13T11:59:00Z",
            windows: [],
            unavailable: { reason: "unsupported" },
          },
        }),
      ],
      NOW,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "unavailable", session: null, weeklies: [] });
    expect(cards[0]!.notice).toContain("no subscription limits");
  });

  it("marks failed probes and missing windows as not reported", () => {
    const cards = selectUsageCards(
      [
        provider({
          driver: "codex",
          instanceId: "codex",
          usageLimits: {
            checkedAt: "2026-09-13T11:59:00Z",
            windows: [],
            unavailable: { reason: "probeFailed", message: "Could not reach Codex." },
          },
        }),
      ],
      NOW,
    );
    expect(cards[0]).toMatchObject({ status: "not-reported" });
    expect(cards[0]!.notice).toBe("Could not reach Codex.");
  });

  it("leaves a missing weekly row empty rather than inventing one", () => {
    const cards = selectUsageCards(
      [
        provider({
          driver: "claudeAgent",
          instanceId: "claudeAgent",
          usageLimits: {
            checkedAt: "2026-09-13T11:59:00Z",
            windows: [CLAUDE_WINDOWS[0]!],
          },
        }),
      ],
      NOW,
    );
    expect(cards[0]!.status).toBe("ready");
    expect(cards[0]!.session).not.toBeNull();
    expect(cards[0]!.weeklies).toEqual([]);
  });

  it("keeps every Claude weekly window in server order with labels intact", () => {
    const cards = selectUsageCards(
      [
        provider({
          driver: "claudeAgent",
          instanceId: "claudeAgent",
          usageLimits: claudeLimits([
            window({
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 42,
              resetsAt: "2026-09-13T14:30:00Z",
              windowDurationMins: 300,
            }),
            window({
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 17,
              resetsAt: "2026-09-20T12:00:00Z",
            }),
            window({
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: 55,
              resetsAt: "2026-09-20T12:00:00Z",
            }),
          ]),
        }),
      ],
      NOW,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("ready");
    expect(cards[0]!.session).toMatchObject({ id: "five_hour", label: "Session" });
    expect(cards[0]!.weeklies.map((row) => row.id)).toEqual(["seven_day", "seven_day_fable"]);
    expect(cards[0]!.weeklies.map((row) => row.label)).toEqual(["Weekly", "Weekly · Fable"]);
    expect(cards[0]!.weeklies[0]).toMatchObject({ usedPercent: 17 });
    expect(cards[0]!.weeklies[1]).toMatchObject({ usedPercent: 55 });
  });

  it("skips drivers with no configured instance and ignores other drivers", () => {
    const cards = selectUsageCards([provider({ driver: "ollama", instanceId: "ollama" })], NOW);
    expect(cards).toEqual([]);
  });

  it("prefers the freshest snapshot when a driver has several instances", () => {
    const cards = selectUsageCards(
      [
        provider({
          driver: "codex",
          instanceId: "codex_old",
          usageLimits: {
            checkedAt: "2026-09-13T09:00:00Z",
            windows: [window({ id: "primary", kind: "session", usedPercent: 90 })],
          },
        }),
        provider({
          driver: "codex",
          instanceId: "codex",
          usageLimits: {
            checkedAt: "2026-09-13T11:59:00Z",
            windows: [window({ id: "primary", kind: "session", usedPercent: 11 })],
          },
        }),
      ],
      NOW,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.session).toMatchObject({ usedPercent: 11 });
  });
});
