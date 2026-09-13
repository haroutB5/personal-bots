import { describe, expect, it } from "@effect/vitest";

import {
  EXPLICIT_REMEMBER_REQUEST,
  formatNextRun,
  routineScheduleFromToolInput,
} from "./handlers.ts";

describe("create_routine input mapping", () => {
  it("maps natural fields onto schedules", () => {
    expect(
      routineScheduleFromToolInput({
        title: "t",
        prompt: "p",
        frequency: "weekly",
        days: ["monday", "friday"],
        time: "08:30",
      }),
    ).toEqual({ kind: "weekly", days: [1, 5], time: "08:30" });
    expect(
      routineScheduleFromToolInput({
        title: "t",
        prompt: "p",
        frequency: "every_n_hours",
        everyHours: 4,
      }),
    ).toEqual({ kind: "interval", everyHours: 4 });
    expect(
      routineScheduleFromToolInput({
        title: "t",
        prompt: "p",
        frequency: "once",
        date: "2026-12-24",
        time: "18:00",
      }),
    ).toEqual({ kind: "once", at: "2026-12-24T18:00" });
  });

  it("explains missing or malformed fields", () => {
    expect(
      routineScheduleFromToolInput({ title: "t", prompt: "p", frequency: "daily", time: "9am" }),
    ).toContain("HH:MM");
    expect(
      routineScheduleFromToolInput({ title: "t", prompt: "p", frequency: "weekly", time: "09:00" }),
    ).toContain("at least one day");
    expect(
      routineScheduleFromToolInput({ title: "t", prompt: "p", frequency: "once", time: "09:00" }),
    ).toContain("YYYY-MM-DD");
  });

  it("formats the next run in the routine's own zone", () => {
    expect(formatNextRun("2026-09-14T08:00:00.000Z", "Europe/London")).toBe(
      "Mon 14 Sept, 09:00 BST",
    );
    expect(formatNextRun(null, "Europe/London")).toBeNull();
  });
});

describe("save_memory consent", () => {
  it.each([
    "Remember that I take my coffee black",
    "please don't forget my sister's birthday is 3 May",
    "keep in mind I'm vegetarian",
    "save this for later",
  ])("accepts %s", (request) => {
    expect(EXPLICIT_REMEMBER_REQUEST.test(request)).toBe(true);
  });

  it.each(["I take my coffee black", "What's the weather?", "I remembered it wrong"])(
    "rejects %s",
    (request) => {
      expect(EXPLICIT_REMEMBER_REQUEST.test(request)).toBe(false);
    },
  );
});
