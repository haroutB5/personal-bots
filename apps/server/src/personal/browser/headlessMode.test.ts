// @effect-diagnostics nodeBuiltinImport:off - the test writes a temp profile/lock; there is no Effect file API in a unit test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  BROWSER_HEADED_ENV,
  BROWSER_HEADLESS_ENV,
  browserModePinned,
  describeLaunchFailure,
  discoverGraphicalSession,
  hasGraphicalSession,
  resolveBrowserHeadless,
} from "./headlessMode.ts";

const roots: string[] = [];

/** A fake XDG_RUNTIME_DIR: sockets are plain files, which is all the lookup reads. */
const runtimeDir = (entries: ReadonlyArray<string> = []) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-session-"));
  roots.push(dir);
  for (const entry of entries) {
    const full = NodePath.join(dir, entry);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, "");
  }
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("shared browser headless mode", () => {
  it("runs headless on a Linux server with no display, so Chrome can start under systemd", () => {
    expect(resolveBrowserHeadless({}, "linux")).toBe(true);
    expect(resolveBrowserHeadless({ DISPLAY: "  " }, "linux")).toBe(true);
  });

  it("stays headed on Linux when the owner has a graphical session", () => {
    expect(resolveBrowserHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(resolveBrowserHeadless({ WAYLAND_DISPLAY: "wayland-1" }, "linux")).toBe(false);
    expect(resolveBrowserHeadless({}, "linux", true)).toBe(false);
  });

  it("stays headed on Windows and macOS, which always have a session", () => {
    expect(resolveBrowserHeadless({}, "win32")).toBe(false);
    expect(resolveBrowserHeadless({}, "darwin")).toBe(false);
  });

  it("honours the explicit switches, and knows when the mode is pinned", () => {
    expect(resolveBrowserHeadless({ [BROWSER_HEADLESS_ENV]: "1", DISPLAY: ":0" }, "linux")).toBe(
      true,
    );
    expect(resolveBrowserHeadless({ [BROWSER_HEADED_ENV]: "1" }, "linux")).toBe(false);
    expect(
      resolveBrowserHeadless({ [BROWSER_HEADLESS_ENV]: "1", [BROWSER_HEADED_ENV]: "1" }, "linux"),
    ).toBe(true);
    expect(browserModePinned({})).toBe(false);
    expect(browserModePinned({ [BROWSER_HEADED_ENV]: "1" })).toBe(true);
  });

  it("reads a graphical session from either variable only", () => {
    expect(hasGraphicalSession({ DISPLAY: ":0" })).toBe(true);
    expect(hasGraphicalSession({ WAYLAND_DISPLAY: "wayland-1" })).toBe(true);
    expect(hasGraphicalSession({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(false);
  });
});

describe("graphical session discovery at launch", () => {
  it("finds the wayland socket, Hyprland instance and user bus a boot-started service lacks", () => {
    const dir = runtimeDir(["wayland-1", "hypr/abc123/.socket.sock", "bus"]);
    const session = discoverGraphicalSession(
      { XDG_RUNTIME_DIR: dir },
      { platform: "linux", runtimeDir: dir },
    );
    expect(session.available).toBe(true);
    expect(session.env.WAYLAND_DISPLAY).toBe("wayland-1");
    expect(session.env.HYPRLAND_INSTANCE_SIGNATURE).toBe("abc123");
    expect(session.env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${dir}/bus`);
    expect(session.detail).toContain("wayland-1");
  });

  it("prefers wayland-0 and keeps variables the service already had", () => {
    const dir = runtimeDir(["wayland-1", "wayland-0"]);
    const session = discoverGraphicalSession(
      { XDG_RUNTIME_DIR: dir, HYPRLAND_INSTANCE_SIGNATURE: "given" },
      { platform: "linux", runtimeDir: dir },
    );
    expect(session.env.WAYLAND_DISPLAY).toBe("wayland-0");
    expect(session.env.HYPRLAND_INSTANCE_SIGNATURE).toBe("given");
  });

  it("reports no session on an empty runtime directory, so the launch goes headless", () => {
    const dir = runtimeDir();
    const session = discoverGraphicalSession(
      { XDG_RUNTIME_DIR: dir },
      { platform: "linux", runtimeDir: dir },
    );
    expect(session.available).toBe(false);
    expect(session.detail).toContain("no graphical session");
  });

  it("keeps a wayland name whose socket is not there from counting as a session", () => {
    const dir = runtimeDir();
    const session = discoverGraphicalSession(
      { XDG_RUNTIME_DIR: dir, WAYLAND_DISPLAY: "wayland-9" },
      { platform: "linux", runtimeDir: dir },
    );
    expect(session.available).toBe(false);
  });
});

describe("launch failure message", () => {
  it("names the missing session instead of Chrome's wrapper text", () => {
    const detail = describeLaunchFailure(
      "browserType.launchPersistentContext: Target page, context or browser has been closed\nLooks like you launched a headed browser without having a XServer running.",
    );
    expect(detail).toContain("graphical session");
    expect(detail).toContain("T3CODE_PERSONAL_BROWSER_HEADLESS");
  });

  it("keeps the first line for any other failure", () => {
    expect(describeLaunchFailure("boom\nsecond line")).toBe("Chrome failed to start: boom");
  });
});
