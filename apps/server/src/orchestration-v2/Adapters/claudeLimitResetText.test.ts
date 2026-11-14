import { describe, expect, it } from "vite-plus/test";

import { claudeLimitResetFromText } from "./claudeLimitResetText.ts";

const at = (iso: string) => Date.parse(iso);

describe("claudeLimitResetFromText", () => {
  it("reads the 5-hour limit's wall-clock reset in its named zone", () => {
    expect(
      claudeLimitResetFromText(
        "You've hit your 5-hour limit · resets 5:50am (Europe/London)",
        at("2026-11-14T02:36:01Z"),
      ),
    ).toBe("2026-11-14T05:50:00.000Z");
  });

  it("takes the next such time when today's has passed, in summer time too", () => {
    expect(
      claudeLimitResetFromText(
        "You've hit your session limit · resets 1am (Europe/London)",
        at("2026-07-01T22:00:00Z"),
      ),
    ).toBe("2026-07-02T00:00:00.000Z");
    expect(
      claudeLimitResetFromText(
        "You've hit your session limit · resets 5:20pm (Europe/Berlin)",
        at("2026-11-14T10:00:00Z"),
      ),
    ).toBe("2026-11-14T16:20:00.000Z");
  });

  it("reads a dated weekly reset, rolling into next year when the date is behind", () => {
    expect(
      claudeLimitResetFromText(
        "You've hit your weekly limit · resets Nov 20, 9am (Europe/London)",
        at("2026-11-14T02:36:01Z"),
      ),
    ).toBe("2026-11-20T09:00:00.000Z");
    expect(
      claudeLimitResetFromText(
        "You've hit your weekly limit · resets Jan 2, 9am (Europe/London)",
        at("2026-12-30T12:00:00Z"),
      ),
    ).toBe("2027-01-02T09:00:00.000Z");
  });

  it("names no reset for text without one, an unknown zone, or an impossible time", () => {
    const base = at("2026-11-14T02:36:01Z");
    expect(claudeLimitResetFromText("Claude API rate limit reached. Try again later.", base)).toBe(
      undefined,
    );
    expect(claudeLimitResetFromText("resets 5:50am (Mars/Olympus)", base)).toBe(undefined);
    expect(claudeLimitResetFromText("resets 13:50pm (Europe/London)", base)).toBe(undefined);
  });
});
