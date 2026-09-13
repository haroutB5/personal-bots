import { describe, expect, it } from "vite-plus/test";

import { parseVersionLabel } from "./appVersion";

const VERSION_FILE = [
  "release=7ae8f86d9b18",
  "sha=7ae8f86d9b18",
  "branch=personal-bots/main",
  "dirty=False",
  "builtAt=2026-09-13T17:35:09Z",
  "cli=t3 v0.0.40",
].join("\r\n");

describe("parseVersionLabel", () => {
  it("shortens the release and appends the build day", () => {
    const label = parseVersionLabel(VERSION_FILE);
    expect(label).toMatch(/^7ae8f86 · /);
  });

  it("falls back to the bare release when builtAt is missing or bad", () => {
    expect(parseVersionLabel("release=7ae8f86d9b18")).toBe("7ae8f86");
    expect(parseVersionLabel("release=7ae8f86d9b18\nbuiltAt=not-a-date")).toBe("7ae8f86");
  });

  it("returns null without a release line", () => {
    expect(parseVersionLabel("")).toBeNull();
    expect(parseVersionLabel("<!doctype html><html></html>")).toBeNull();
    expect(parseVersionLabel("sha=7ae8f86d9b18")).toBeNull();
  });
});
