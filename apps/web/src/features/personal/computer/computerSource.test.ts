import { describe, expect, it } from "vitest";

import {
  AUTO_TAP_GRACE_MS,
  DEFAULT_SOURCE_PREFS,
  followedToast,
  loadSourcePrefs,
  parseSourcePrefs,
  resolveSource,
  saveSourcePrefs,
  type ResolveSourceInput,
} from "./computerSource";

const base: ResolveSourceInput = {
  prefs: { auto: true, pinned: "browser" },
  current: "browser",
  helpOpen: false,
  controlSource: null,
  lastBotAction: null,
  lastTapAt: null,
  now: 100_000,
  desktopAvailable: true,
};

describe("resolveSource", () => {
  it("keeps the current source when nothing has happened", () => {
    expect(resolveSource(base)).toBe("browser");
    expect(resolveSource({ ...base, current: "desktop" })).toBe("desktop");
  });

  it("follows the newest bot action", () => {
    expect(resolveSource({ ...base, lastBotAction: { source: "desktop", at: 99_000 } })).toBe(
      "desktop",
    );
  });

  it("shows the browser while a help request is open", () => {
    expect(
      resolveSource({
        ...base,
        current: "desktop",
        helpOpen: true,
        lastBotAction: { source: "desktop", at: 99_000 },
      }),
    ).toBe("browser");
  });

  it("never moves away from the source you control", () => {
    expect(
      resolveSource({
        ...base,
        controlSource: "desktop",
        helpOpen: true,
        lastBotAction: { source: "browser", at: 99_000 },
      }),
    ).toBe("desktop");
  });

  it("holds still for 3 s after your own tap, then follows", () => {
    const moved = { ...base, lastBotAction: { source: "desktop" as const, at: 99_000 } };
    expect(resolveSource({ ...moved, lastTapAt: 100_000 - AUTO_TAP_GRACE_MS + 1 })).toBe("browser");
    expect(resolveSource({ ...moved, lastTapAt: 100_000 - AUTO_TAP_GRACE_MS })).toBe("desktop");
  });

  it("uses the pin when Auto is off, even if the bot moved", () => {
    expect(
      resolveSource({
        ...base,
        prefs: { auto: false, pinned: "browser" },
        lastBotAction: { source: "desktop", at: 99_000 },
      }),
    ).toBe("browser");
  });

  it("falls back to the browser when the desktop is not available", () => {
    expect(
      resolveSource({
        ...base,
        desktopAvailable: false,
        lastBotAction: { source: "desktop", at: 99_000 },
      }),
    ).toBe("browser");
    expect(
      resolveSource({
        ...base,
        desktopAvailable: false,
        prefs: { auto: false, pinned: "desktop" },
      }),
    ).toBe("browser");
  });
});

describe("source prefs", () => {
  it("defaults to Auto on the browser", () => {
    expect(parseSourcePrefs(null)).toEqual(DEFAULT_SOURCE_PREFS);
    expect(parseSourcePrefs("not json")).toEqual(DEFAULT_SOURCE_PREFS);
    expect(parseSourcePrefs("7")).toEqual(DEFAULT_SOURCE_PREFS);
  });

  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveSourcePrefs(storage, { auto: false, pinned: "desktop" });
    expect(loadSourcePrefs(storage)).toEqual({ auto: false, pinned: "desktop" });
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSourcePrefs(broken)).toEqual(DEFAULT_SOURCE_PREFS);
    expect(() => saveSourcePrefs(broken, DEFAULT_SOURCE_PREFS)).not.toThrow();
  });
});

describe("followedToast", () => {
  it("names the bot and where it went", () => {
    expect(followedToast("browser", "desktop", "Assistant")).toBe(
      "Followed Assistant to the desktop",
    );
    expect(followedToast("desktop", "browser", null)).toBe("Followed the bot to the browser");
    expect(followedToast("browser", "browser", "Assistant")).toBeNull();
  });
});
