import { describe, expect, it } from "vite-plus/test";

import { formatWorkingElapsed, spokenWorkingElapsed } from "./workingElapsed";

describe("formatWorkingElapsed", () => {
  it("reads 12s, 4m 12s, 1h 04m", () => {
    expect(formatWorkingElapsed(0)).toBe("0s");
    expect(formatWorkingElapsed(12_400)).toBe("12s");
    expect(formatWorkingElapsed(59_600)).toBe("59s");
    expect(formatWorkingElapsed(60_000)).toBe("1m 00s");
    expect(formatWorkingElapsed(4 * 60_000 + 12_000)).toBe("4m 12s");
    expect(formatWorkingElapsed(59 * 60_000 + 59_000)).toBe("59m 59s");
    expect(formatWorkingElapsed(60 * 60_000)).toBe("1h 00m");
    expect(formatWorkingElapsed(64 * 60_000 + 30_000)).toBe("1h 04m");
  });

  it("never reads a negative", () => {
    expect(formatWorkingElapsed(-5_000)).toBe("0s");
  });
});

describe("spokenWorkingElapsed", () => {
  it("speaks the same time", () => {
    expect(spokenWorkingElapsed(0)).toBe("0 seconds");
    expect(spokenWorkingElapsed(1_000)).toBe("1 second");
    expect(spokenWorkingElapsed(4 * 60_000 + 12_000)).toBe("4 minutes 12 seconds");
    expect(spokenWorkingElapsed(60 * 60_000)).toBe("1 hour");
    expect(spokenWorkingElapsed(60 * 60_000 + 4 * 60_000)).toBe("1 hour 4 minutes");
  });
});
