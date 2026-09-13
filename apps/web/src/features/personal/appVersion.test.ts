import { describe, expect, it } from "vite-plus/test";

import { parseVersionLabel } from "./appVersion";

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

  it("returns null without a version or release line", () => {
    expect(parseVersionLabel("")).toBeNull();
    expect(parseVersionLabel("<!doctype html><html></html>")).toBeNull();
    expect(parseVersionLabel("sha=7ae8f86d9b18")).toBeNull();
  });
});
