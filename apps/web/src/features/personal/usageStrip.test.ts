import { describe, expect, it } from "vite-plus/test";

import type { UsageCard, UsageCardDriver, UsageWindowRow } from "./usagePresentation";
import {
  formatStripPercent,
  selectUsageStripCells,
  stripBindingWindow,
  stripCellBarPercent,
  stripShortWindow,
  usageStripAriaLabel,
} from "./usageStrip";

describe("stripShortWindow", () => {
  const cell = (sessionPercent: number | null, weeklyPercent: number | null) => ({
    driver: "claudeAgent" as UsageCardDriver,
    title: "Claude",
    sessionPercent,
    weeklyPercent,
  });

  it("names the window the bar is filled to", () => {
    expect(stripShortWindow(cell(60, 59))).toBe("session");
    expect(stripShortWindow(cell(2, 90))).toBe("weekly");
  });

  it("reads a tie or a missing figure as the other window, weekly first", () => {
    expect(stripShortWindow(cell(40, 40))).toBe("weekly");
    expect(stripShortWindow(cell(null, 12))).toBe("weekly");
    expect(stripShortWindow(cell(12, null))).toBe("session");
    expect(stripShortWindow(cell(null, null))).toBe("weekly");
  });
});

function row(overrides: Partial<UsageWindowRow> = {}): UsageWindowRow {
  return {
    id: "five_hour",
    label: "5-hour session",
    usedPercent: 26,
    resetLabel: "resets in 2h 30m",
    resetTimeLabel: "Resets 14:30",
    ...overrides,
  };
}

function card(overrides: Partial<UsageCard> & { driver: UsageCardDriver }): UsageCard {
  return {
    title: overrides.driver === "claudeAgent" ? "Claude" : "Codex",
    plan: undefined,
    status: "ready",
    notice: null,
    session: null,
    weeklies: [],
    checkedAt: null,
    ...overrides,
  };
}

describe("selectUsageStripCells", () => {
  it("keeps card order — Claude left, Codex right — with session and first weekly", () => {
    const cells = selectUsageStripCells([
      card({
        driver: "claudeAgent",
        session: row(),
        weeklies: [
          row({ id: "seven_day", label: "Weekly", usedPercent: 8 }),
          row({ id: "seven_day_fable", label: "Weekly · Fable", usedPercent: 55 }),
        ],
      }),
      card({ driver: "codex", session: row({ id: "primary", usedPercent: 12 }) }),
    ]);
    expect(cells).toEqual([
      { driver: "claudeAgent", title: "Claude", sessionPercent: 26, weeklyPercent: 8 },
      { driver: "codex", title: "Codex", sessionPercent: 12, weeklyPercent: null },
    ]);
  });

  it("nulls the figures for cards that cannot report, never zeroes them", () => {
    const cells = selectUsageStripCells([
      card({ driver: "claudeAgent", status: "unavailable", notice: "No subscription limits." }),
      card({ driver: "codex", status: "not-reported" }),
    ]);
    expect(cells.map((cell) => cell.sessionPercent)).toEqual([null, null]);
    expect(cells.map((cell) => cell.weeklyPercent)).toEqual([null, null]);
    expect(cells.map((cell) => cell.title)).toEqual(["Claude", "Codex"]);
  });

  it("nulls a ready card's missing session row instead of dropping the cell", () => {
    const cells = selectUsageStripCells([
      card({ driver: "claudeAgent", weeklies: [row({ id: "seven_day", usedPercent: 3 })] }),
    ]);
    expect(cells).toEqual([
      { driver: "claudeAgent", title: "Claude", sessionPercent: null, weeklyPercent: 3 },
    ]);
  });

  it("has no cells when no provider is configured yet", () => {
    expect(selectUsageStripCells([])).toEqual([]);
  });
});

describe("formatStripPercent", () => {
  it("shows a dash rather than a misleading zero", () => {
    expect(formatStripPercent(null)).toBe("–");
    expect(formatStripPercent(0)).toBe("0%");
    expect(formatStripPercent(26)).toBe("26%");
  });
});

describe("usageStripAriaLabel", () => {
  it("reads every figure the bars only draw", () => {
    const label = usageStripAriaLabel([
      { driver: "claudeAgent", title: "Claude", sessionPercent: 26, weeklyPercent: 8 },
      { driver: "codex", title: "Codex", sessionPercent: 12, weeklyPercent: null },
    ]);
    expect(label).toBe(
      "Usage: Claude, Session 26 percent used, Weekly 8 percent used; Codex, Session 12 percent used, Weekly not reported. Open details.",
    );
  });

  it("names providers that report nothing", () => {
    const label = usageStripAriaLabel([
      { driver: "claudeAgent", title: "Claude", sessionPercent: null, weeklyPercent: null },
      { driver: "codex", title: "Codex", sessionPercent: null, weeklyPercent: 4 },
    ]);
    expect(label).toBe(
      "Usage: Claude, Session not reported, Weekly not reported; Codex, Session not reported, Weekly 4 percent used. Open details.",
    );
  });
});

describe("stripCellBarPercent", () => {
  /**
   * The reported bug: "Session 0% . Weekly 100% used" over an empty bar. The
   * bar tracked the 5-hour window alone, so a spent weekly allowance drew as
   * untouched capacity.
   */
  it("fills to the spent weekly window while the session sits idle", () => {
    expect(
      stripCellBarPercent({
        driver: "claudeAgent",
        title: "Claude",
        sessionPercent: 0,
        weeklyPercent: 100,
      }),
    ).toBe(100);
  });

  it("shows whichever window binds first", () => {
    const cell = (sessionPercent: number | null, weeklyPercent: number | null) =>
      stripCellBarPercent({ driver: "codex", title: "Codex", sessionPercent, weeklyPercent });
    expect(cell(88, 12)).toBe(88);
    expect(cell(12, 88)).toBe(88);
    expect(cell(0, 0)).toBe(0);
    // One window reported, the other not: the reported one still draws.
    expect(cell(null, 43)).toBe(43);
    expect(cell(43, null)).toBe(43);
    // Nothing reported at all: no bar, rather than a zero that reads as empty.
    expect(cell(null, null)).toBeNull();
  });
});

describe("stripBindingWindow", () => {
  const cell = (sessionPercent: number | null, weeklyPercent: number | null) =>
    ({
      driver: "claudeAgent" as UsageCardDriver,
      title: "Claude",
      sessionPercent,
      weeklyPercent,
    }) satisfies Parameters<typeof stripBindingWindow>[0];

  it("names the window that is about to stop a bot", () => {
    // The bar fills to the worse window either way; the text is the only place
    // that can say a spent week (days to clear) from a spent session (hours).
    expect(stripBindingWindow(cell(0, 100))).toBe("weekly");
    expect(stripBindingWindow(cell(95, 12))).toBe("session");
    // A tie goes to the one that takes longer to come back.
    expect(stripBindingWindow(cell(90, 90))).toBe("weekly");
  });

  it("stays quiet while there is headroom, or nothing was reported", () => {
    expect(stripBindingWindow(cell(40, 79))).toBeNull();
    expect(stripBindingWindow(cell(null, null))).toBeNull();
  });
});
