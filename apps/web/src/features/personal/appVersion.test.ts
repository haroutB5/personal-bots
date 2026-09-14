import { describe, expect, it } from "vite-plus/test";

import { parseVersionLabel, parseVersionStamp, runningClientEntry } from "./appVersion";

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
