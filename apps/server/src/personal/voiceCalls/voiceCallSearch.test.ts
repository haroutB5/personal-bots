import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  cleanSearchQuery,
  nextPacificMidnightMs,
  searchQuotaStillHolds,
  shapeSearchResults,
} from "./voiceCallSearch.ts";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

describe("nextPacificMidnightMs", () => {
  it("is 07:00 UTC in summer (PDT) and 08:00 UTC in winter (PST)", () => {
    // 2026-10-16 09:30 BST = 08:30 UTC = 01:30 PDT on the 16th: midnight is the
    // start of the 17th Pacific, 07:00 UTC.
    expect(iso(nextPacificMidnightMs(Date.parse("2026-10-16T08:30:00Z")))).toBe(
      "2026-10-17T07:00:00.000Z",
    );
    expect(iso(nextPacificMidnightMs(Date.parse("2026-01-15T12:00:00Z")))).toBe(
      "2026-01-16T08:00:00.000Z",
    );
  });

  it("moves to the next day exactly at midnight Pacific", () => {
    // 06:59:59 UTC is still 23:59:59 PDT the day before.
    expect(iso(nextPacificMidnightMs(Date.parse("2026-10-17T06:59:59Z")))).toBe(
      "2026-10-17T07:00:00.000Z",
    );
    expect(iso(nextPacificMidnightMs(Date.parse("2026-10-17T07:00:00Z")))).toBe(
      "2026-10-18T07:00:00.000Z",
    );
  });

  it("follows the clock change: the day clocks fall back is 25 hours long", () => {
    // 2026-11-01: PDT ends at 02:00. Midnight starting the 1st is 07:00 UTC
    // (PDT); the one after is 08:00 UTC on the 2nd (PST).
    expect(iso(nextPacificMidnightMs(Date.parse("2026-11-01T15:00:00Z")))).toBe(
      "2026-11-02T08:00:00.000Z",
    );
    expect(iso(nextPacificMidnightMs(Date.parse("2026-10-31T20:00:00Z")))).toBe(
      "2026-11-01T07:00:00.000Z",
    );
  });

  it("follows the clock change: the day clocks spring forward is 23 hours long", () => {
    // 2026-03-08: PST ends at 02:00. Midnight starting the 8th is 08:00 UTC
    // (PST); the one after is 07:00 UTC on the 9th (PDT).
    expect(iso(nextPacificMidnightMs(Date.parse("2026-03-07T20:00:00Z")))).toBe(
      "2026-03-08T08:00:00.000Z",
    );
    expect(iso(nextPacificMidnightMs(Date.parse("2026-03-08T20:00:00Z")))).toBe(
      "2026-03-09T07:00:00.000Z",
    );
  });
});

describe("searchQuotaStillHolds", () => {
  const noted = "2026-10-16T08:30:00.000Z"; // 01:30 PDT on the 16th
  const reset = Date.parse("2026-10-17T07:00:00Z");

  it("holds from the moment it was noted until the next midnight Pacific", () => {
    expect(searchQuotaStillHolds(noted, Date.parse(noted))).toBe(true);
    expect(searchQuotaStillHolds(noted, reset - 1)).toBe(true);
  });

  it("lapses at the reset, so Search is tried again", () => {
    expect(searchQuotaStillHolds(noted, reset)).toBe(false);
    expect(searchQuotaStillHolds(noted, reset + 3_600_000)).toBe(false);
  });

  it("counts a late-evening note against the same Pacific day only", () => {
    // 23:30 PDT on the 16th is 06:30 UTC on the 17th: the reset is half an hour away.
    const late = "2026-10-17T06:30:00.000Z";
    expect(searchQuotaStillHolds(late, Date.parse("2026-10-17T06:45:00Z"))).toBe(true);
    expect(searchQuotaStillHolds(late, Date.parse("2026-10-17T07:00:00Z"))).toBe(false);
  });

  it("reads nothing remembered, or something unreadable, as available", () => {
    expect(searchQuotaStillHolds(null, 0)).toBe(false);
    expect(searchQuotaStillHolds("not a date", 0)).toBe(false);
  });
});

describe("shapeSearchResults", () => {
  it("keeps title, snippet and url, one line each", () => {
    expect(
      shapeSearchResults([
        { title: "A  title\n here", content: "Some\n  text.", url: "https://a.example/x" },
      ]),
    ).toEqual([{ title: "A title here", snippet: "Some text.", url: "https://a.example/x" }]);
  });

  it("caps the count at four and each field", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      title: "t".repeat(400) + index,
      content: "s".repeat(900),
      url: `https://e.example/${"u".repeat(600)}`,
    }));
    const shaped = shapeSearchResults(rows);
    expect(shaped).toHaveLength(4);
    for (const row of shaped) {
      expect(row.title.length).toBeLessThanOrEqual(120);
      expect(row.snippet.length).toBeLessThanOrEqual(320);
      expect(row.url.length).toBeLessThanOrEqual(200);
    }
    expect(JSON.stringify(shaped).length).toBeLessThan(3_000);
  });

  it("drops a row with nothing readable in it", () => {
    expect(
      shapeSearchResults([
        { title: "  ", content: "\n", url: "https://x.example" },
        { title: "Kept", content: "", url: "" },
      ]),
    ).toEqual([{ title: "Kept", snippet: "", url: "" }]);
    expect(shapeSearchResults([])).toEqual([]);
  });
});

describe("cleanSearchQuery", () => {
  it("is one bounded line", () => {
    expect(cleanSearchQuery("  weather\n in   Croydon ")).toBe("weather in Croydon");
    expect(cleanSearchQuery("q".repeat(900)).length).toBeLessThanOrEqual(200);
  });
});
