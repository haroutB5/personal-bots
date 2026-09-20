import { describe, expect, it, vi } from "vite-plus/test";

import {
  parseVersionLabel,
  parseVersionStamp,
  reloadLatestApp,
  runningClientEntry,
} from "./appVersion";

const VERSION_FILE = [
  "version=1.0.0",
  "release=7ae8f86d9b18",
  "sha=7ae8f86d9b18",
  "branch=personal-bots/main",
  "dirty=False",
  "builtAt=2026-09-13T17:35:09Z",
  "cli=t3 v0.0.40",
].join("\r\n");

describe("parseVersionLabel", () => {
  it("prefers the human version", () => {
    expect(parseVersionLabel(VERSION_FILE)).toBe("v1.0.0");
  });

  it("falls back to the short release sha when the version is missing or empty", () => {
    expect(parseVersionLabel("release=7ae8f86d9b18")).toBe("7ae8f86");
    expect(parseVersionLabel("version=\nrelease=7ae8f86d9b18")).toBe("7ae8f86");
  });

  it("parses the client entry for stale-bundle detection", () => {
    expect(parseVersionStamp(`${VERSION_FILE}\r\nclient=index-BGoWf-TO.js`).clientEntry).toBe(
      "index-BGoWf-TO.js",
    );
    expect(parseVersionStamp(VERSION_FILE).clientEntry).toBeNull();
    expect(parseVersionStamp("client=").clientEntry).toBeNull();
  });

  it("finds the running entry script and ignores other scripts", () => {
    const doc = {
      querySelectorAll: () =>
        [
          { getAttribute: () => "/sw.js" },
          { getAttribute: () => "/assets/index-OLDHASH1.js" },
        ] as unknown as NodeListOf<Element>,
    };
    expect(runningClientEntry(doc as unknown as Document)).toBe("index-OLDHASH1.js");
    const none = {
      querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    };
    expect(runningClientEntry(none as unknown as Document)).toBeNull();
  });

  it("returns null without a version or release line", () => {
    expect(parseVersionLabel("")).toBeNull();
    expect(parseVersionLabel("<!doctype html><html></html>")).toBeNull();
    expect(parseVersionLabel("sha=7ae8f86d9b18")).toBeNull();
  });
});

describe("reloadLatestApp", () => {
  it("clears every saved app shell before reloading once", async () => {
    const removed: string[] = [];
    const reload = vi.fn();

    await reloadLatestApp(
      {
        keys: async () => ["bots-shell-old", "bots-pending-nav", "bots-shell-current"],
        delete: async (cacheName) => {
          removed.push(cacheName);
          return true;
        },
      },
      reload,
    );

    expect(removed).toEqual(["bots-shell-old", "bots-shell-current"]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved shell when offline and still reloads", async () => {
    const removed: string[] = [];
    const reload = vi.fn();

    // Offline the shell in that cache is the only copy of the app: clearing it
    // and reloading gives a blank page instead of the stale-but-working app.
    await reloadLatestApp(
      {
        keys: async () => ["bots-shell-current"],
        delete: async (cacheName) => {
          removed.push(cacheName);
          return true;
        },
      },
      reload,
      () => false,
    );

    expect(removed).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("clears the shell when online", async () => {
    const removed: string[] = [];
    const reload = vi.fn();
    await reloadLatestApp(
      {
        keys: async () => ["bots-shell-current"],
        delete: async (cacheName) => {
          removed.push(cacheName);
          return true;
        },
      },
      reload,
      () => true,
    );
    expect(removed).toEqual(["bots-shell-current"]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads once when cache storage is unavailable", async () => {
    const reload = vi.fn();
    await reloadLatestApp(
      {
        keys: async () => {
          throw new Error("storage unavailable");
        },
        delete: async () => false,
      },
      reload,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
