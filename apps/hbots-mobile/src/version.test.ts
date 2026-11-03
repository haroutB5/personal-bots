import { describe, expect, it } from "vite-plus/test";

import { isNewerVersion, isTooOld, versionCodeOf } from "./version";

describe("versionCodeOf", () => {
  it("matches the scaffold rule", () => {
    expect(versionCodeOf("1.66.112")).toBe(1_066_112);
    expect(versionCodeOf("0.0.0")).toBe(0);
    expect(versionCodeOf("12.999.1")).toBe(12_999_001);
  });

  it("refuses anything outside three parts of 0 to 999", () => {
    expect(versionCodeOf("1.66")).toBeNull();
    expect(versionCodeOf("1.66.1000")).toBeNull();
    expect(versionCodeOf("1.66.-1")).toBeNull();
    expect(versionCodeOf("1.66.x")).toBeNull();
  });
});

describe("isTooOld", () => {
  it("compares the installed build with the server minimum", () => {
    expect(isTooOld("1.66.109", "1.66.110")).toBe(true);
    expect(isTooOld("1.66.110", "1.66.110")).toBe(false);
    expect(isTooOld("1.66.111", "1.66.110")).toBe(false);
    expect(isTooOld("unknown", "1.66.110")).toBe(false);
  });
});

describe("isNewerVersion", () => {
  it("offers only a higher code", () => {
    expect(isNewerVersion("1.66.111", "1.66.110")).toBe(true);
    expect(isNewerVersion("1.66.110", "1.66.110")).toBe(false);
    expect(isNewerVersion("1.66.109", "1.66.110")).toBe(false);
  });
});
