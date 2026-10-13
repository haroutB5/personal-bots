import { describe, expect, it } from "vite-plus/test";

import { chartRuns } from "./PerfChart";

/*
 * The drawing half of the gap rule (QA NO-SHIP, 13 Oct): the chart is fed one
 * slot per 2 s sample interval on the fixed 15-minute axis, and a stretch
 * nobody watched arrives as a run of nulls. The drawing must break the line
 * there instead of bridging it, and draw one unbroken line everywhere else.
 */

/** A slot series of a full 15 minutes (450 slots at 2 s). */
const slots = (value: (index: number) => number | null): Array<number | null> =>
  Array.from({ length: 450 }, (_, index) => value(index));

describe("chartRuns on the time axis", () => {
  it("draws one unbroken run when every slot has data", () => {
    const runs = chartRuns(
      slots((index) => 20 + (index % 10)),
      290,
    );
    expect(runs.length).toBe(1);
  });

  it("breaks the line across a stretch nobody watched, and only there", () => {
    // 70 s nobody watched (35 empty slots): exactly what leaving the tab
    // produced in QA, which the first build bridged with a straight line.
    const runs = chartRuns(
      slots((index) => (index >= 200 && index < 235 ? null : 20)),
      290,
    );
    expect(runs.length).toBe(2);
    const endOfFirst = runs[0]!.at(-1)![0];
    const startOfSecond = runs[1]![0]![0];
    expect(endOfFirst).toBeLessThan(200);
    expect(startOfSecond).toBeGreaterThanOrEqual(235);
  });

  it("keeps the line whole over one missing slot (a bridged tick)", () => {
    // The axis carries the previous reading over a missed tick, so a single
    // hole never reaches the drawing as a null run.
    const runs = chartRuns(
      slots((index) => (index === 200 ? null : 20)),
      290,
    );
    expect(runs.length).toBe(1);
  });
});
