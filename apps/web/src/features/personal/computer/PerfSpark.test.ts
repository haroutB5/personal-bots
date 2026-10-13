import { describe, expect, it } from "vite-plus/test";

import { sparkPoints } from "./PerfSpark";

/*
 * The sparks ride the same fixed time axis as the charts (QA NO-SHIP, 13 Oct):
 * they are fed the same slot series, so a stretch nobody watched must break
 * their line too, exactly like the chart's.
 */

/** A slot series of a full 15 minutes (450 slots at 2 s). */
const slots = (value: (index: number) => number | null): Array<number | null> =>
  Array.from({ length: 450 }, (_, index) => value(index));

const moves = (line: string): number => (line.match(/M/g) ?? []).length;

describe("sparkPoints on the time axis", () => {
  it("draws one line when every slot has data", () => {
    const { line } = sparkPoints(
      slots((index) => 1000 + (index % 50)),
      128,
      28,
      0,
      1500,
    );
    expect(moves(line)).toBe(1);
  });

  it("breaks the line across a stretch nobody watched", () => {
    const values = slots((index) => (index >= 200 && index < 235 ? null : 1000 + (index % 50)));
    const { line } = sparkPoints(values, 128, 28, 0, 1500);
    expect(moves(line)).toBe(2);
  });
});
