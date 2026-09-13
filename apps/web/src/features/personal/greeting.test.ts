import { describe, expect, it } from "vite-plus/test";

import { greetingFor, greetingLine, hourInTimeZone, teamStatusLine } from "./greeting";

describe("greetingFor", () => {
  it("splits the day at 12:00 and 18:00 London time", () => {
    expect(greetingFor(new Date("2026-01-15T11:59:00Z"))).toBe("Morning");
    expect(greetingFor(new Date("2026-01-15T12:00:00Z"))).toBe("Afternoon");
    expect(greetingFor(new Date("2026-01-15T17:59:00Z"))).toBe("Afternoon");
    expect(greetingFor(new Date("2026-01-15T18:00:00Z"))).toBe("Evening");
    expect(greetingFor(new Date("2026-01-15T00:30:00Z"))).toBe("Morning");
  });

  it("follows BST: the same UTC instant reads an hour later after the spring change", () => {
    // Clocks go forward 2026-03-29 01:00 UTC.
    expect(hourInTimeZone(new Date("2026-03-28T11:30:00Z"))).toBe(11);
    expect(greetingFor(new Date("2026-03-28T11:30:00Z"))).toBe("Morning");
    expect(hourInTimeZone(new Date("2026-03-29T11:30:00Z"))).toBe(12);
    expect(greetingFor(new Date("2026-03-29T11:30:00Z"))).toBe("Afternoon");
  });

  it("follows GMT again after the autumn change", () => {
    // Clocks go back 2026-10-25 01:00 UTC.
    expect(greetingFor(new Date("2026-10-24T17:30:00Z"))).toBe("Evening");
    expect(greetingFor(new Date("2026-10-25T17:30:00Z"))).toBe("Afternoon");
  });

  it("honours an explicit timezone", () => {
    expect(greetingFor(new Date("2026-06-01T20:00:00Z"), "America/New_York")).toBe("Afternoon");
  });
});

describe("greetingLine", () => {
  it("adds the display name only when one is set", () => {
    const evening = new Date("2026-09-13T20:00:00Z");
    expect(greetingLine(evening, "Harout")).toBe("Evening, Harout");
    expect(greetingLine(evening, "   ")).toBe("Evening");
  });
});

describe("teamStatusLine", () => {
  it("prefers running work, then review, then idle", () => {
    expect(teamStatusLine({ botCount: 0, runningCount: 0, reviewCount: 0 })).toBe(
      "Let's set up your team.",
    );
    expect(teamStatusLine({ botCount: 4, runningCount: 1, reviewCount: 1 })).toBe(
      "Your team is on it.",
    );
    expect(teamStatusLine({ botCount: 4, runningCount: 0, reviewCount: 2 })).toBe(
      "Something needs your review.",
    );
    expect(teamStatusLine({ botCount: 4, runningCount: 0, reviewCount: 0 })).toBe("All quiet.");
  });
});
