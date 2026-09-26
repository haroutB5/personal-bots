import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatResetCountdown,
  formatResetTime,
  resetCreditsExpiresIn,
  resetCreditsHeadline,
  selectUsageCards,
  usageCardEmptyText,
  usageNeedsRefreshOnOpen,
  USAGE_STALE_AFTER_MS,
  type UsageCard,
} from "./usagePresentation";

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

describe("banked reset credits copy", () => {
  it("names the count with the right plural", () => {
    expect(resetCreditsHeadline(1)).toBe("1 reset banked");
    expect(resetCreditsHeadline(2)).toBe("2 resets banked");
  });

  it("formats the time until the next credit expires, or null", () => {
    const at = new Date(NOW + (26 * 24 + 15) * 3_600_000 + 1_000).toISOString();
    expect(resetCreditsExpiresIn({ availableCount: 1, nextExpiresAt: at }, NOW)).toBe("26d 15h");
    expect(resetCreditsExpiresIn({ availableCount: 1 }, NOW)).toBeNull();
    expect(resetCreditsExpiresIn({ availableCount: 1, nextExpiresAt: "garbage" }, NOW)).toBeNull();
  });
});

describe("formatResetTime", () => {
  it("shows the local clock time today and adds a weekday on another day", () => {
    const localNow = new Date(2026, 8, 13, 12, 0).getTime();
    const today = new Date(2026, 8, 13, 14, 30).toISOString();
    const monday = new Date(2026, 8, 14, 9, 0).toISOString();
    expect(formatResetTime(today, localNow)).toBe("Resets 14:30");
    expect(formatResetTime(monday, localNow)).toBe("Resets Mon 09:00");
  });

  it("returns null when the provider does not report a valid reset", () => {
    expect(formatResetTime(undefined, NOW)).toBeNull();
    expect(formatResetTime("not-a-date", NOW)).toBeNull();
  });
});

describe("selectUsageCards", () => {
  it("builds Claude and Codex cards with session and weekly rows", () => {
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
    expect(cards.map((card) => card.title)).toEqual(["Claude", "Codex"]);
    const [claude, codex] = cards;
    expect(claude!.status).toBe("ready");
    expect(claude!.session).toMatchObject({ usedPercent: 42, resetLabel: "resets in 2h 30m" });
    expect(claude!.weeklies).toHaveLength(1);
    expect(claude!.weeklies[0]).toMatchObject({ usedPercent: 17, resetLabel: "resets in 7d 0h" });
    expect(codex!.plan).toBe("ChatGPT Plus");
    expect(codex!.session).toMatchObject({ usedPercent: 63, resetLabel: "resets in 45m" });
  });

  it("carries banked reset credits with the instance to redeem them on", () => {
    const [claude, codex] = selectUsageCards(
      [
        provider({
          driver: "claudeAgent",
          instanceId: "claude-work",
          usageLimits: {
            ...claudeLimits(),
            resetCredits: { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00Z" },
          },
        }),
        provider({ driver: "codex", instanceId: "codex", usageLimits: claudeLimits() }),
      ],
      NOW,
    );
    expect(claude!.resetCredits).toEqual({
      credits: { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00Z" },
      input: { instanceId: "claude-work" },
    });
    expect(codex!.resetCredits).toBeNull();
  });

  it("offers no redeem on a card without bars", () => {
    const [claude] = selectUsageCards(
      [
        provider({
          driver: "claudeAgent",
          instanceId: "claudeAgent",
          usageLimits: {
            checkedAt: "2026-09-13T11:59:00Z",
            windows: [],
            resetCredits: { availableCount: 1 },
            unavailable: { reason: "probeFailed", message: "401 Incorrect API key provided" },
          },
        }),
      ],
      NOW,
    );
    expect(claude!.status).toBe("not-reported");
    expect(claude!.resetCredits).toBeNull();
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

describe("usage refresh on open", () => {
  const card = (overrides: Partial<UsageCard> = {}): UsageCard => ({
    driver: "claudeAgent",
    title: "Claude",
    plan: "Max",
    status: "ready",
    notice: null,
    session: null,
    weeklies: [],
    checkedAt: 1_000_000,
    resetCredits: null,
    ...overrides,
  });

  it("probes when a card has never been checked", () => {
    expect(
      usageNeedsRefreshOnOpen([card({ status: "not-reported", checkedAt: null })], 1_000_000),
    ).toBe(true);
  });

  it("probes when the only reading is stale", () => {
    const checkedAt = 1_000_000;
    expect(
      usageNeedsRefreshOnOpen(
        [card({ status: "not-reported", checkedAt })],
        checkedAt + USAGE_STALE_AFTER_MS + 1,
      ),
    ).toBe(true);
  });

  it("leaves a fresh reading alone so reopening does not spend a probe", () => {
    const checkedAt = 1_000_000;
    expect(
      usageNeedsRefreshOnOpen([card({ status: "not-reported", checkedAt })], checkedAt + 1_000),
    ).toBe(false);
  });

  it("probes when the bars on screen are hours old (the 'Updated 7h' sheet)", () => {
    const checkedAt = 1_000_000;
    expect(
      usageNeedsRefreshOnOpen([card({ status: "ready", checkedAt })], checkedAt + 7 * 60 * 60_000),
    ).toBe(true);
  });

  it("leaves fresh bars alone", () => {
    const checkedAt = 1_000_000;
    expect(usageNeedsRefreshOnOpen([card({ status: "ready", checkedAt })], checkedAt + 1_000)).toBe(
      false,
    );
  });

  it("does not probe for an account that can never report", () => {
    expect(usageNeedsRefreshOnOpen([card({ status: "unavailable", checkedAt: null })], 1)).toBe(
      false,
    );
  });

  it("probes when there are no cards at all", () => {
    expect(usageNeedsRefreshOnOpen([], 1)).toBe(true);
  });

  it("says it is checking rather than reporting an absence it has not verified", () => {
    const pending = card({ status: "not-reported", checkedAt: null });

    expect(usageCardEmptyText(pending, { checking: true })).toBe("Checking…");
    expect(usageCardEmptyText(pending, { checking: false })).toBe(
      "Usage is not reported for this account yet.",
    );
  });

  it("keeps the unavailable wording even mid-probe, because a probe cannot change it", () => {
    const unavailable = card({ status: "unavailable", checkedAt: null });

    expect(usageCardEmptyText(unavailable, { checking: true })).toBe(
      "This account has no subscription limits.",
    );
  });
});
