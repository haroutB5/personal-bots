import { describe, expect, it } from "vite-plus/test";

import { formatMessageTime, messageTimeParts, parseSentAt } from "./messageTime";

// Friday 9 Oct 2026, 14:00 in London (BST, one hour ahead of UTC).
const NOW = new Date("2026-10-09T13:00:00Z");
const at = (iso: string) => new Date(iso);

describe("messageTimeParts", () => {
  it("shows only the clock time for today, in London time", () => {
    expect(messageTimeParts(at("2026-10-09T13:32:00Z"), NOW)).toEqual({ day: null, time: "14:32" });
    // Winter is GMT: the same wall clock as UTC.
    expect(messageTimeParts(at("2026-01-15T14:32:00Z"), at("2026-01-15T20:00:00Z"))).toEqual({
      day: null,
      time: "14:32",
    });
  });

  it("calls the day before Yesterday", () => {
    expect(messageTimeParts(at("2026-10-08T13:32:00Z"), NOW)).toEqual({
      day: "Yesterday",
      time: "14:32",
    });
  });

  it("names the weekday from two to six days back", () => {
    expect(messageTimeParts(at("2026-10-07T13:32:00Z"), NOW).day).toBe("Wed");
    expect(messageTimeParts(at("2026-10-06T13:32:00Z"), NOW).day).toBe("Tue");
    expect(messageTimeParts(at("2026-10-03T13:32:00Z"), NOW).day).toBe("Sat");
  });

  it("gives the date from a week back, with the year only when it is not this year", () => {
    expect(messageTimeParts(at("2026-10-02T13:32:00Z"), NOW)).toEqual({
      day: "2 Oct",
      time: "14:32",
    });
    expect(messageTimeParts(at("2026-03-01T09:05:00Z"), NOW)).toEqual({
      day: "1 Mar",
      time: "09:05",
    });
    expect(messageTimeParts(at("2025-12-25T12:00:00Z"), NOW)).toEqual({
      day: "25 Dec 2025",
      time: "12:00",
    });
  });

  it("uses London days, not UTC days, at midnight", () => {
    // 23:30 UTC on the 8th is 00:30 BST on the 9th: today.
    expect(messageTimeParts(at("2026-10-08T23:30:00Z"), NOW)).toEqual({ day: null, time: "00:30" });
    // 22:50 UTC on the 8th is 23:50 BST the same evening; just after midnight London it is Yesterday.
    expect(messageTimeParts(at("2026-10-08T22:50:00Z"), at("2026-10-08T23:10:00Z"))).toEqual({
      day: "Yesterday",
      time: "23:50",
    });
  });

  it("keeps the weekday across New Year, and puts the year on an older date", () => {
    const now = at("2027-01-02T12:00:00Z");
    expect(messageTimeParts(at("2026-12-30T12:00:00Z"), now).day).toBe("Wed");
    expect(messageTimeParts(at("2026-12-20T12:00:00Z"), now).day).toBe("20 Dec 2026");
  });

  it("falls back to the date for a message from the future (a clock that is off)", () => {
    expect(messageTimeParts(at("2026-10-10T13:32:00Z"), NOW)).toEqual({
      day: "10 Oct",
      time: "14:32",
    });
  });
});

describe("formatMessageTime", () => {
  it("is the day and the time on one line", () => {
    expect(formatMessageTime(at("2026-10-09T13:32:00Z"), NOW)).toBe("14:32");
    expect(formatMessageTime(at("2026-10-08T13:32:00Z"), NOW)).toBe("Yesterday 14:32");
    expect(formatMessageTime(at("2026-10-08T13:32:00Z"), NOW)).not.toContain(",");
    expect(formatMessageTime(at("2026-10-07T13:32:00Z"), NOW)).toBe("Wed 14:32");
    expect(formatMessageTime(at("2026-10-02T13:32:00Z"), NOW)).toBe("2 Oct 14:32");
    expect(formatMessageTime(at("2025-12-25T12:00:00Z"), NOW)).toBe("25 Dec 2025 12:00");
  });
});

describe("parseSentAt", () => {
  it("reads an ISO time and gives nothing for a missing or unreadable one", () => {
    expect(parseSentAt("2026-10-09T13:32:00Z")?.toISOString()).toBe("2026-10-09T13:32:00.000Z");
    expect(parseSentAt(undefined)).toBeNull();
    expect(parseSentAt(null)).toBeNull();
    expect(parseSentAt("")).toBeNull();
    expect(parseSentAt("not a date")).toBeNull();
  });
});
