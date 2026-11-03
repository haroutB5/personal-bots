import { describe, expect, it } from "vite-plus/test";

import { parseReleaseVersion, requireReleaseVersion } from "./versionCode.ts";

describe("parseReleaseVersion", () => {
  it("derives the Android code from a release name", () => {
    expect(parseReleaseVersion("1.66.112")?.code).toBe(1_066_112);
    expect(parseReleaseVersion("0.0.0")?.code).toBe(0);
    expect(parseReleaseVersion("12.999.1")?.code).toBe(12_999_001);
    expect(parseReleaseVersion("999.999.999")?.code).toBe(999_999_999);
  });

  it("refuses a part that would collide with the next one", () => {
    expect(parseReleaseVersion("1.66.1000")).toBeNull();
    expect(parseReleaseVersion("1.1000.0")).toBeNull();
    expect(parseReleaseVersion("1000.0.0")).toBeNull();
  });

  it("refuses a name that is not three decimal parts", () => {
    expect(parseReleaseVersion("1.66")).toBeNull();
    expect(parseReleaseVersion("1.66.112-beta")).toBeNull();
    expect(parseReleaseVersion("v1.66.112")).toBeNull();
    expect(parseReleaseVersion("1..112")).toBeNull();
    expect(parseReleaseVersion("")).toBeNull();
  });

  it("keeps the code rising across every kind of bump", () => {
    expect(parseReleaseVersion("1.66.113")?.code).toBeGreaterThan(
      parseReleaseVersion("1.66.112")?.code ?? 0,
    );
    expect(parseReleaseVersion("1.67.0")?.code).toBeGreaterThan(
      parseReleaseVersion("1.66.999")?.code ?? 0,
    );
    expect(parseReleaseVersion("2.0.0")?.code).toBeGreaterThan(
      parseReleaseVersion("1.999.999")?.code ?? 0,
    );
  });
});

describe("requireReleaseVersion", () => {
  it("names the file that must be fixed", () => {
    expect(() => requireReleaseVersion("1.66.1000", "app-version.txt")).toThrow(
      "app-version.txt must be x.y.z with each part 0-999, got 1.66.1000",
    );
  });
});
