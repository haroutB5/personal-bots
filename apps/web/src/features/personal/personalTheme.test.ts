import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_PERSONAL_THEME_MODE,
  isPersonalThemeMode,
  PERSONAL_THEME_MODES,
  resolvePersonalAppearance,
} from "./personalTheme";

describe("resolvePersonalAppearance", () => {
  it("honours an explicit choice regardless of the OS", () => {
    expect(resolvePersonalAppearance("dark", false)).toBe("dark");
    expect(resolvePersonalAppearance("light", true)).toBe("light");
  });

  it("follows the OS in System mode", () => {
    expect(resolvePersonalAppearance("system", true)).toBe("dark");
    expect(resolvePersonalAppearance("system", false)).toBe("light");
  });

  it("falls back to System, not Light, for a missing or corrupt preference", () => {
    // A device with a dark OS and nothing stored (or junk stored by an older
    // build) must open dark. Defaulting to "light" here is how a dark mode
    // ships with a white flash on every cold start.
    expect(resolvePersonalAppearance(null, true)).toBe("dark");
    expect(resolvePersonalAppearance(undefined, true)).toBe("dark");
    expect(resolvePersonalAppearance("midnight" as never, true)).toBe("dark");
    expect(resolvePersonalAppearance(null, false)).toBe("light");
  });

  it("offers exactly the three documented modes, System first", () => {
    expect(PERSONAL_THEME_MODES).toEqual(["system", "light", "dark"]);
    expect(DEFAULT_PERSONAL_THEME_MODE).toBe("system");
  });
});

describe("isPersonalThemeMode", () => {
  it("accepts the three modes and rejects anything else", () => {
    for (const mode of PERSONAL_THEME_MODES) expect(isPersonalThemeMode(mode)).toBe(true);
    for (const value of ["", "System", "auto", null, undefined, 0, {}]) {
      expect(isPersonalThemeMode(value)).toBe(false);
    }
  });
});
