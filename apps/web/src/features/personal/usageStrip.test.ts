import { describe, expect, it } from "vite-plus/test";

import type { UsageCard, UsageCardDriver, UsageWindowRow } from "./usagePresentation";
import { formatStripPercent, selectUsageStripCells, usageStripAriaLabel } from "./usageStrip";

function row(overrides: Partial<UsageWindowRow> = {}): UsageWindowRow {
  return {
    id: "five_hour",
    label: "5-hour session",
    usedPercent: 26,
    resetLabel: "resets in 2h 30m",
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
      "Usage: Claude session 26 percent, weekly 8 percent; Codex session 12 percent. Open details.",
    );
  });

  it("names providers that report nothing", () => {
    const label = usageStripAriaLabel([
      { driver: "claudeAgent", title: "Claude", sessionPercent: null, weeklyPercent: null },
      { driver: "codex", title: "Codex", sessionPercent: null, weeklyPercent: 4 },
    ]);
    expect(label).toBe(
      "Usage: Claude usage not reported; Codex session not reported, weekly 4 percent. Open details.",
    );
  });
});
