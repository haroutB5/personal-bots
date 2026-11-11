import { describe, expect, it } from "vite-plus/test";

import { backendSettingFromEnvironment, resolveBackend } from "./browserBackend.ts";

describe("backendSettingFromEnvironment", () => {
  it("defaults to owned", () => {
    expect(backendSettingFromEnvironment({})).toEqual({ kind: "owned" });
    expect(backendSettingFromEnvironment({ T3CODE_PERSONAL_BROWSER_BACKEND: "  " })).toEqual({
      kind: "owned",
    });
  });

  it("an explicit owned ignores a shared folder", () => {
    expect(
      backendSettingFromEnvironment({
        T3CODE_PERSONAL_BROWSER_BACKEND: "owned",
        T3CODE_PERSONAL_BROWSER_SHARED_DIR: "/brave",
      }),
    ).toEqual({ kind: "owned" });
  });

  it("shared names the folder Brave writes DevToolsActivePort into", () => {
    expect(
      backendSettingFromEnvironment({
        T3CODE_PERSONAL_BROWSER_BACKEND: "shared",
        T3CODE_PERSONAL_BROWSER_SHARED_DIR: " /brave ",
      }),
    ).toEqual({ kind: "shared", userDataDir: "/brave" });
  });

  it("shared without a folder is a configuration error, never a silent fall back to owned", () => {
    expect(() =>
      backendSettingFromEnvironment({ T3CODE_PERSONAL_BROWSER_BACKEND: "shared" }),
    ).toThrow("T3CODE_PERSONAL_BROWSER_SHARED_DIR");
  });

  it("an unknown value is a configuration error", () => {
    expect(() =>
      backendSettingFromEnvironment({ T3CODE_PERSONAL_BROWSER_BACKEND: "sharde" }),
    ).toThrow('T3CODE_PERSONAL_BROWSER_BACKEND must be "owned" or "shared"');
  });
});

describe("resolveBackend", () => {
  it("no setting means owned in hbots' own folder", () => {
    expect(resolveBackend(undefined, "/own")).toEqual({ kind: "owned", profileDir: "/own" });
  });

  it("shared carries only his folder, so it has nowhere to put a launch or a lock cleanup", () => {
    expect(resolveBackend({ kind: "shared", userDataDir: "/brave" }, "/own")).toEqual({
      kind: "shared",
      userDataDir: "/brave",
    });
  });
});
