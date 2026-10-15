import { describe, expect, it } from "vite-plus/test";

import { deepSeekPeakWindowEndMs } from "./deepseekPeak.ts";

describe("DeepSeek UTC peak windows", () => {
  it("matches the calendar across weekdays, boundaries, DST and pre-epoch dates", () => {
    const at = Date.UTC(1969, 11, 1);
    for (let hour = 0; hour < 24 * 40; hour += 1) {
      for (const base of [at, Date.UTC(2026, 9, 1)]) {
        for (const offset of [-1, 0, 0.5, 1]) {
          const ms = base + hour * 3_600_000 + offset;
          const date = new Date(ms);
          const utcHour = date.getUTCHours();
          const end =
            date.getUTCDay() % 6 === 0
              ? null
              : utcHour >= 1 && utcHour < 4
                ? 4
                : utcHour >= 6 && utcHour < 10
                  ? 10
                  : null;
          const expected = end === null ? null : date.setUTCHours(end, 0, 0, 0);
          expect(deepSeekPeakWindowEndMs(ms)).toBe(expected);
        }
      }
    }
  });

  it("rejects invalid dates and accepts Date's finite range", () => {
    for (const ms of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1]) {
      expect(deepSeekPeakWindowEndMs(ms)).toBeNull();
    }
    expect(deepSeekPeakWindowEndMs(8.64e15)).toBeNull();
    expect(deepSeekPeakWindowEndMs(-8.64e15)).toBeNull();
  });
});
