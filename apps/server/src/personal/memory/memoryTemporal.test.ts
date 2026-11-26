import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { PersonalMemoryId } from "@t3tools/contracts";

import {
  classifyMemoryQueryIntent,
  groundRelativeDate,
  sortChronologically,
} from "./memoryTemporal.ts";

// Wednesday, 2026-11-25 12:00:00Z
const WED_NOON_UTC = Date.parse("2026-11-25T12:00:00.000Z");

describe("groundRelativeDate", () => {
  it("resolves today and yesterday in UTC", () => {
    expect(groundRelativeDate("Deployed build today", WED_NOON_UTC, "UTC")).toBe("2026-11-25");
    expect(groundRelativeDate("Shipped hotfix yesterday", WED_NOON_UTC, "UTC")).toBe("2026-11-24");
  });

  it("resolves N days ago, a day ago, N weeks ago, a week ago, and last week", () => {
    expect(groundRelativeDate("Switched DNS 3 days ago", WED_NOON_UTC, "UTC")).toBe("2026-11-22");
    expect(groundRelativeDate("Updated config 1 day ago", WED_NOON_UTC, "UTC")).toBe("2026-11-24");
    expect(groundRelativeDate("Updated config a day ago", WED_NOON_UTC, "UTC")).toBe("2026-11-24");
    expect(groundRelativeDate("Migrated DB 2 weeks ago", WED_NOON_UTC, "UTC")).toBe("2026-11-11");
    expect(groundRelativeDate("Migrated DB a week ago", WED_NOON_UTC, "UTC")).toBe("2026-11-18");
    expect(groundRelativeDate("Started refactor last week", WED_NOON_UTC, "UTC")).toBe(
      "2026-11-18",
    );
  });

  it("resolves last Monday..Sunday strictly in the past", () => {
    // 2026-11-25 is Wednesday
    expect(groundRelativeDate("Met last Tuesday", WED_NOON_UTC, "UTC")).toBe("2026-11-24");
    expect(groundRelativeDate("Deployed last Monday", WED_NOON_UTC, "UTC")).toBe("2026-11-23");
    expect(groundRelativeDate("Ran backup last Sunday", WED_NOON_UTC, "UTC")).toBe("2026-11-22");
    expect(groundRelativeDate("Checked last Saturday", WED_NOON_UTC, "UTC")).toBe("2026-11-21");
    expect(groundRelativeDate("Released last Friday", WED_NOON_UTC, "UTC")).toBe("2026-11-20");
    expect(groundRelativeDate("Tested last Thursday", WED_NOON_UTC, "UTC")).toBe("2026-11-19");
    // Same weekday resolves to 7 days prior, never today
    expect(groundRelativeDate("Synced last Wednesday", WED_NOON_UTC, "UTC")).toBe("2026-11-18");
  });

  it("respects the provided timeZone across midnight boundaries", () => {
    // 2026-11-26 01:30 UTC is still 2026-11-25 in America/New_York
    const earlyUtc = Date.parse("2026-11-26T01:30:00.000Z");
    expect(groundRelativeDate("Checked today", earlyUtc, "UTC")).toBe("2026-11-26");
    expect(groundRelativeDate("Checked today", earlyUtc, "America/New_York")).toBe("2026-11-25");
    expect(groundRelativeDate("Checked yesterday", earlyUtc, "America/New_York")).toBe(
      "2026-11-24",
    );
  });

  it("never resolves future phrases or unrelated text", () => {
    expect(groundRelativeDate("Will deploy tomorrow", WED_NOON_UTC, "UTC")).toBeNull();
    expect(groundRelativeDate("Meeting next week", WED_NOON_UTC, "UTC")).toBeNull();
    expect(groundRelativeDate("Release next Monday", WED_NOON_UTC, "UTC")).toBeNull();
    expect(groundRelativeDate("Expires in 5 days", WED_NOON_UTC, "UTC")).toBeNull();
    expect(groundRelativeDate("Harout prefers dark mode", WED_NOON_UTC, "UTC")).toBeNull();
  });

  it("picks the earliest relative phrase when multiple appear", () => {
    expect(
      groundRelativeDate("Yesterday we fixed what broke 3 days ago", WED_NOON_UTC, "UTC"),
    ).toBe("2026-11-24");
  });
});

describe("classifyMemoryQueryIntent", () => {
  it("classifies temporal and historical queries as temporal_history", () => {
    const temporalQueries = [
      "when did we switch from Vercel to Fly?",
      "what changed in the deployment setup?",
      "what laptop did Harout used to own?",
      "what was previously configured for backups?",
      "previous email address",
      "what was the port before the migration?",
      "history of the Matchday release process",
      "give me the timeline for CalTrack",
      "what was originally chosen for the database?",
      "when was the last time we rotated the key?",
      "since when do we run nightly tidy?",
      "back when we used SQLite v1",
      "formerly hosted on Heroku",
    ];
    for (const query of temporalQueries) {
      expect(classifyMemoryQueryIntent(query), query).toBe("temporal_history");
    }
  });

  it("classifies ordinary queries as default", () => {
    const defaultQueries = [
      "what is Harout's preferred editor?",
      "Matchday deployment rules",
      "current Node version",
      "how do we run tests in hbots?",
      "CalTrack database schema",
    ];
    for (const query of defaultQueries) {
      expect(classifyMemoryQueryIntent(query), query).toBe("default");
    }
  });
});

describe("sortChronologically", () => {
  const item = (id: string, createdAt: string, observedAt: string | null = null) => ({
    memoryId: PersonalMemoryId.make(id),
    createdAt: DateTime.makeUnsafe(Date.parse(createdAt)),
    observedAt,
  });

  it("sorts by observedAt ?? createdAt ascending", () => {
    const entries = [
      item("c", "2026-11-25T10:00:00.000Z", "2026-11-20"),
      item("a", "2026-11-22T10:00:00.000Z", null),
      item("b", "2026-11-26T10:00:00.000Z", "2026-11-10"),
    ];
    expect(sortChronologically(entries).map((e) => e.memoryId)).toEqual(["b", "c", "a"]);
  });
});
