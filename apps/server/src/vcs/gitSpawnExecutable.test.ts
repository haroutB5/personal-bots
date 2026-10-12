import { describe, expect, it, vi } from "vite-plus/test";

import { resolveGitSpawnExecutable } from "./GitVcsDriverCore.ts";

describe("resolveGitSpawnExecutable", () => {
  it("resolves git to an absolute path on Windows", () => {
    const resolver = vi.fn(() => "C:\\Program Files\\Git\\cmd\\git.exe");
    expect(resolveGitSpawnExecutable(resolver, "win32", { PATH: "C:\\bin" })).toBe(
      "C:\\Program Files\\Git\\cmd\\git.exe",
    );
    expect(resolver).toHaveBeenCalledWith("git", "win32", { PATH: "C:\\bin" });
  });

  it("falls back to the bare name when the Windows walk finds nothing", () => {
    // Same failure as before the change: PATH lookup at spawn time, error text intact.
    expect(resolveGitSpawnExecutable(() => undefined, "win32", {})).toBe("git");
  });

  it("never walks PATH on other platforms", () => {
    const resolver = vi.fn(() => "/usr/bin/git");
    expect(resolveGitSpawnExecutable(resolver, "linux", {})).toBe("git");
    expect(resolveGitSpawnExecutable(resolver, "darwin", {})).toBe("git");
    expect(resolver).not.toHaveBeenCalled();
  });
});
