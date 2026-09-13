import { describe, expect, it } from "vite-plus/test";

import { formatRelativeTime } from "./relativeTime";

const now = new Date("2026-09-13T20:40:00Z"); // 21:40 BST

describe("formatRelativeTime", () => {
  it("covers the list steps: Now, minutes, hours", () => {
    expect(formatRelativeTime(new Date("2026-09-13T20:39:30Z"), now)).toBe("Now");
    expect(formatRelativeTime(new Date("2026-09-13T20:36:00Z"), now)).toBe("4m");
    expect(formatRelativeTime(new Date("2026-09-13T20:22:00Z"), now)).toBe("18m");
    expect(formatRelativeTime(new Date("2026-09-13T19:40:00Z"), now)).toBe("1h");
  });

  it("treats future instants as Now", () => {
    expect(formatRelativeTime(new Date("2026-09-13T20:45:00Z"), now)).toBe("Now");
  });

  it("uses London calendar days for Yesterday", () => {
    // 23:30 UTC on the 12th is 00:30 BST on the 13th: same local day.
    expect(formatRelativeTime(new Date("2026-09-12T23:30:00Z"), now)).toBe("21h");
    expect(formatRelativeTime(new Date("2026-09-12T22:30:00Z"), now)).toBe("Yesterday");
  });

  it("falls back to a short date, with the year only when it differs", () => {
    expect(formatRelativeTime(new Date("2026-09-10T10:00:00Z"), now)).toBe("10 Sep");
    expect(formatRelativeTime(new Date("2025-12-31T10:00:00Z"), now)).toBe("31 Dec 2025");
  });

  it("stays correct across the autumn DST change", () => {
    const afterChange = new Date("2026-10-25T09:00:00Z"); // 09:00 GMT
    // 22:30 UTC on the 24th is 23:30 BST on the 24th.
    expect(formatRelativeTime(new Date("2026-10-24T22:30:00Z"), afterChange)).toBe("Yesterday");
    // 23:30 UTC on the 24th is already 00:30 BST on the 25th: same local day.
    expect(formatRelativeTime(new Date("2026-10-24T23:30:00Z"), afterChange)).toBe("9h");
  });
});
