import { describe, expect, it } from "vite-plus/test";

import { draftFromRoutine, sameSchedule, scheduleFromDraft, todayInZone } from "./routineDraft";

const blank = draftFromRoutine(null, "bot-1", "2026-09-14");

describe("routine drafts", () => {
  it("defaults to a weekday-ready daily 09:00 in Europe/London with catch-up", () => {
    expect(blank).toMatchObject({
      botId: "bot-1",
      kind: "daily",
      time: "09:00",
      timeZone: "Europe/London",
      missedPolicy: "coalesce",
    });
  });

  it("builds each schedule kind and reports what is missing", () => {
    expect(scheduleFromDraft({ ...blank, kind: "weekly", days: [5, 1] })).toEqual({
      schedule: { kind: "weekly", days: [1, 5], time: "09:00" },
    });
    expect(scheduleFromDraft({ ...blank, kind: "weekly", days: [] })).toEqual({
      error: "Pick at least one day.",
    });
    expect(scheduleFromDraft({ ...blank, kind: "interval", everyHours: "0" })).toMatchObject({
      error: expect.stringContaining("1 to 168"),
    });
    expect(
      scheduleFromDraft({ ...blank, kind: "once", date: "2026-12-24", time: "18:30" }),
    ).toEqual({
      schedule: { kind: "once", at: "2026-12-24T18:30" },
    });
    expect(scheduleFromDraft({ ...blank, time: "" })).toEqual({ error: "Pick a time." });
  });

  it("round-trips a stored one-off and ignores the interval anchor when comparing", () => {
    expect(
      sameSchedule(
        { kind: "interval", everyHours: 3, anchorAt: "2026-09-14T08:00:00.000Z" },
        { kind: "interval", everyHours: 3 },
      ),
    ).toBe(true);
    expect(sameSchedule({ kind: "daily", time: "09:00" }, { kind: "daily", time: "09:30" })).toBe(
      false,
    );
  });

  it("reads today's date in the routine's zone", () => {
    // 23:30 UTC on the 14th is already the 15th in London (BST).
    expect(todayInZone(Date.parse("2026-09-14T23:30:00Z"), "Europe/London")).toBe("2026-09-15");
  });
});
