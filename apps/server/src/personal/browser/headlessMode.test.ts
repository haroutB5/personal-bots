import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_HEADED_ENV,
  BROWSER_HEADLESS_ENV,
  hasGraphicalSession,
  resolveBrowserHeadless,
} from "./headlessMode.ts";

describe("shared browser headless mode", () => {
  it("runs headless on a Linux server with no display, so Chrome can start under systemd", () => {
    expect(resolveBrowserHeadless({}, "linux")).toBe(true);
    expect(resolveBrowserHeadless({ DISPLAY: "  " }, "linux")).toBe(true);
  });

  it("stays headed on Linux when the owner has a graphical session", () => {
    expect(resolveBrowserHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(resolveBrowserHeadless({ WAYLAND_DISPLAY: "wayland-1" }, "linux")).toBe(false);
  });

  it("stays headed on Windows and macOS, which always have a session", () => {
    expect(resolveBrowserHeadless({}, "win32")).toBe(false);
    expect(resolveBrowserHeadless({}, "darwin")).toBe(false);
  });

  it("honours the explicit switches, the headed one winning over the display check", () => {
    expect(resolveBrowserHeadless({ [BROWSER_HEADLESS_ENV]: "1", DISPLAY: ":0" }, "linux")).toBe(
      true,
    );
    expect(resolveBrowserHeadless({ [BROWSER_HEADED_ENV]: "1" }, "linux")).toBe(false);
    expect(
      resolveBrowserHeadless({ [BROWSER_HEADLESS_ENV]: "1", [BROWSER_HEADED_ENV]: "1" }, "linux"),
    ).toBe(true);
  });

  it("reads a graphical session from either variable only", () => {
    expect(hasGraphicalSession({ DISPLAY: ":0" })).toBe(true);
    expect(hasGraphicalSession({ WAYLAND_DISPLAY: "wayland-1" })).toBe(true);
    expect(hasGraphicalSession({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(false);
  });
});
