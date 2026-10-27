import { describe, expect, it } from "@effect/vitest";

import {
  activeWindow,
  discoverLinuxSession,
  logicalMonitors,
  LinuxSessionError,
  sessionEnv,
} from "./session.ts";

describe("logicalMonitors", () => {
  it("converts physical pixels to the logical units every tool uses", () => {
    const monitors = logicalMonitors([
      {
        id: 0,
        name: "eDP-1",
        width: 3072,
        height: 1920,
        x: 0,
        y: 0,
        scale: 2,
        focused: true,
        dpmsStatus: true,
      },
    ]);
    expect(monitors[0]).toMatchObject({
      index: 0,
      primary: true,
      x: 0,
      y: 0,
      width: 1536,
      height: 960,
      scale: 2,
      dpi: 192,
    });
  });

  it("keeps negative origins and picks the monitor at 0,0 as primary", () => {
    const monitors = logicalMonitors([
      { name: "left", width: 1920, height: 1080, x: -1920, y: 0, scale: 1 },
      { name: "main", width: 2560, height: 1440, x: 0, y: 0, scale: 1, focused: true },
    ]);
    expect(monitors[0]?.primary).toBe(false);
    expect(monitors[1]?.primary).toBe(true);
    expect(monitors[0]?.x).toBe(-1920);
  });

  it("falls back to the focused monitor, then the first", () => {
    const focused = logicalMonitors([
      { name: "a", width: 800, height: 600, x: 10, y: 0, focused: false },
      { name: "b", width: 800, height: 600, x: 900, y: 0, focused: true },
    ]);
    expect(focused.find((entry) => entry.primary)?.name).toBe("b");
    const first = logicalMonitors([
      { name: "a", width: 800, height: 600, x: 10, y: 0 },
      { name: "b", width: 800, height: 600, x: 900, y: 0 },
    ]);
    expect(first.find((entry) => entry.primary)?.name).toBe("a");
  });

  it("never reports a zero size for a malformed monitor", () => {
    const monitors = logicalMonitors([{ name: "odd", width: 0, height: 0, scale: 0 }]);
    expect(monitors[0]?.width).toBe(1);
    expect(monitors[0]?.height).toBe(1);
    expect(monitors[0]?.scale).toBe(1);
  });
});

describe("activeWindow", () => {
  it("reads the title, class and workspace", () => {
    expect(
      activeWindow({
        address: "0x1",
        title: "  Notes ",
        class: "foot",
        workspace: { id: 2, name: "2" },
        monitor: 0,
      }),
    ).toEqual({
      title: "Notes",
      class: "foot",
      address: "0x1",
      workspace: "2",
      monitor: 0,
    });
  });

  it("is null when there is no usable window", () => {
    expect(activeWindow(null)).toBeNull();
    expect(activeWindow({})).toBeNull();
  });
});

describe("discoverLinuxSession", () => {
  it("fails with a sentence, not a crash, when there is no compositor", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "/tmp/opencode/empty-path-for-discovery";
    try {
      await expect(
        discoverLinuxSession({
          XDG_RUNTIME_DIR: "/tmp/opencode/no-such-runtime",
          WAYLAND_DISPLAY: "wayland-9",
          HYPRLAND_INSTANCE_SIGNATURE: "nope",
        }),
      ).rejects.toBeInstanceOf(LinuxSessionError);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("passes the session's environment to its children", () => {
    const env = sessionEnv({
      waylandDisplay: "wayland-1",
      xdgRuntimeDir: "/run/user/1000",
      hyprlandInstance: "sig",
      uid: 1000,
    });
    expect(env.WAYLAND_DISPLAY).toBe("wayland-1");
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(env.HYPRLAND_INSTANCE_SIGNATURE).toBe("sig");
  });
});
