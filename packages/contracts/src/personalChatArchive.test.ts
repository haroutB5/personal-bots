import { describe, expect, it } from "vite-plus/test";

import {
  formatPersonalChatArchiveAfterDuration,
  parsePersonalChatArchiveAfterDuration,
  personalChatArchiveAfterDurationLabel,
  personalChatArchiveAfterMinutesFromStored,
  personalChatArchiveAfterMinutesValid,
  PERSONAL_CHAT_ARCHIVE_AFTER_DEFAULT_MINUTES,
  PERSONAL_CHAT_ARCHIVE_AFTER_MAX_MINUTES,
  PERSONAL_CHAT_ARCHIVE_AFTER_MIN_MINUTES,
} from "./personalChatArchive.ts";

describe("parsePersonalChatArchiveAfterDuration", () => {
  it("reads minutes and hours, in any case and with an optional space", () => {
    expect(parsePersonalChatArchiveAfterDuration("30m")).toBe(30);
    expect(parsePersonalChatArchiveAfterDuration("90M")).toBe(90);
    expect(parsePersonalChatArchiveAfterDuration("90 M")).toBe(90);
    expect(parsePersonalChatArchiveAfterDuration("48h")).toBe(48 * 60);
    expect(parsePersonalChatArchiveAfterDuration("2H")).toBe(120);
    expect(parsePersonalChatArchiveAfterDuration("  2 h  ")).toBe(120);
  });

  it("reads a bare number as hours", () => {
    expect(parsePersonalChatArchiveAfterDuration("48")).toBe(2880);
    expect(parsePersonalChatArchiveAfterDuration("1")).toBe(60);
    // 5 is 5 hours, not 5 minutes: still valid.
    expect(parsePersonalChatArchiveAfterDuration("5")).toBe(300);
  });

  it("holds the range edges and refuses everything outside them", () => {
    expect(PERSONAL_CHAT_ARCHIVE_AFTER_MIN_MINUTES).toBe(5);
    expect(PERSONAL_CHAT_ARCHIVE_AFTER_MAX_MINUTES).toBe(720 * 60);
    expect(parsePersonalChatArchiveAfterDuration("5m")).toBe(5);
    expect(parsePersonalChatArchiveAfterDuration("720h")).toBe(43200);

    expect(parsePersonalChatArchiveAfterDuration("4m")).toBeNull();
    expect(parsePersonalChatArchiveAfterDuration("721h")).toBeNull();
    expect(parsePersonalChatArchiveAfterDuration("0")).toBeNull();
    expect(parsePersonalChatArchiveAfterDuration("0m")).toBeNull();
  });

  it("refuses decimals, negatives, other units, words and empty text", () => {
    for (const text of ["1.5h", "1,5h", "-30m", "10d", "abc", "", "   ", "30 s", "m", "h"]) {
      expect(parsePersonalChatArchiveAfterDuration(text), text).toBeNull();
    }
    // A bare "30" is 30 hours, so it is valid, not null.
    expect(parsePersonalChatArchiveAfterDuration("30")).toBe(1800);
    expect(parsePersonalChatArchiveAfterDuration("9".repeat(30) + "h")).toBeNull();
  });
});

describe("personalChatArchiveAfterMinutesFromStored", () => {
  it("reads a stored count of minutes and falls back to 48 hours", () => {
    expect(PERSONAL_CHAT_ARCHIVE_AFTER_DEFAULT_MINUTES).toBe(2880);
    expect(personalChatArchiveAfterMinutesFromStored("30")).toBe(30);
    expect(personalChatArchiveAfterMinutesFromStored(" 43200 ")).toBe(43200);

    for (const stored of [null, undefined, "", "abc", "0", "4", "43201", "1.5", "-60"]) {
      expect(personalChatArchiveAfterMinutesFromStored(stored), String(stored)).toBe(2880);
    }
  });
});

describe("formatPersonalChatArchiveAfterDuration", () => {
  it("shows whole hours as hours and everything else as minutes", () => {
    expect(formatPersonalChatArchiveAfterDuration(2880)).toBe("48h");
    expect(formatPersonalChatArchiveAfterDuration(120)).toBe("2h");
    expect(formatPersonalChatArchiveAfterDuration(60)).toBe("1h");
    expect(formatPersonalChatArchiveAfterDuration(90)).toBe("90m");
    expect(formatPersonalChatArchiveAfterDuration(5)).toBe("5m");
  });

  it("round-trips every valid value through text", () => {
    for (const minutes of [5, 30, 60, 90, 120, 2880, 43200]) {
      expect(
        parsePersonalChatArchiveAfterDuration(formatPersonalChatArchiveAfterDuration(minutes)),
      ).toBe(minutes);
    }
  });
});

describe("personalChatArchiveAfterDurationLabel", () => {
  it("says hours, singular and plural, and minutes otherwise", () => {
    expect(personalChatArchiveAfterDurationLabel(2880)).toBe("48 hours");
    expect(personalChatArchiveAfterDurationLabel(60)).toBe("1 hour");
    expect(personalChatArchiveAfterDurationLabel(120)).toBe("2 hours");
    expect(personalChatArchiveAfterDurationLabel(90)).toBe("90 minutes");
    expect(personalChatArchiveAfterDurationLabel(5)).toBe("5 minutes");
  });
});

describe("personalChatArchiveAfterMinutesValid", () => {
  it("accepts whole minutes in range only", () => {
    expect(personalChatArchiveAfterMinutesValid(5)).toBe(true);
    expect(personalChatArchiveAfterMinutesValid(43200)).toBe(true);
    expect(personalChatArchiveAfterMinutesValid(4)).toBe(false);
    expect(personalChatArchiveAfterMinutesValid(43201)).toBe(false);
    expect(personalChatArchiveAfterMinutesValid(1.5)).toBe(false);
    expect(personalChatArchiveAfterMinutesValid(Number.NaN)).toBe(false);
  });
});
