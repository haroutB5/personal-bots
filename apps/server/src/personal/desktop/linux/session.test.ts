// @effect-diagnostics nodeBuiltinImport:off - the fixture writes stand-in oracle scripts on PATH.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  activeWindow,
  discoverLinuxSession,
  logicalMonitors,
  LinuxSessionError,
  mappedWindows,
  sessionEnv,
  sessionLocked,
  visibleWorkspaces,
  type LinuxSession,
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
        pid: 321,
        title: "  Notes ",
        class: "foot",
        workspace: { id: 2, name: "2" },
        monitor: 0,
      }),
    ).toEqual({
      title: "Notes",
      class: "foot",
      pid: 321,
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

describe("mappedWindows", () => {
  it("keeps mapped, on-screen windows in layout pixels", () => {
    expect(
      mappedWindows([
        {
          class: "brave-abc-Default",
          pid: 4321,
          title: "Bank",
          at: [-120, 40],
          size: [800, 600],
          mapped: true,
          hidden: false,
        },
      ]),
    ).toEqual([
      {
        class: "brave-abc-Default",
        title: "Bank",
        pid: 4321,
        x: -120,
        y: 40,
        width: 800,
        height: 600,
      },
    ]);
  });

  it("drops windows on hidden workspaces and malformed sizes", () => {
    const windows = mappedWindows([
      { class: "hidden", at: [0, 0], size: [10, 10], mapped: false },
      { class: "special", at: [0, 0], size: [10, 10], mapped: true, hidden: true },
      { class: "zero", at: [0, 0], size: [0, 0], mapped: true },
      { class: "shown", at: [0, 0], size: [10, 10], mapped: true },
    ]);
    expect(windows.map((window) => window.class)).toEqual(["shown"]);
  });

  it("counts only windows on a workspace a monitor is showing (QA's B3)", () => {
    const visible = visibleWorkspaces([
      {
        activeWorkspace: { id: 2, name: "2" },
        specialWorkspace: { id: -99, name: "special:scratch" },
      },
    ]);
    const windows = mappedWindows(
      [
        {
          class: "active",
          at: [0, 0],
          size: [10, 10],
          mapped: true,
          workspace: { id: 2, name: "2" },
        },
        {
          class: "hidden-ws",
          at: [0, 0],
          size: [10, 10],
          mapped: true,
          workspace: { id: 6, name: "6" },
        },
        {
          class: "pinned",
          at: [0, 0],
          size: [10, 10],
          mapped: true,
          pinned: true,
          workspace: { id: 6, name: "6" },
        },
        {
          class: "special-shown",
          at: [0, 0],
          size: [10, 10],
          mapped: true,
          workspace: { id: -99, name: "special:scratch" },
        },
        {
          class: "special-hidden",
          at: [0, 0],
          size: [10, 10],
          mapped: true,
          workspace: { id: -98, name: "special:notes" },
        },
      ],
      visible,
    );
    expect(windows.map((window) => window.class)).toEqual(["active", "pinned", "special-shown"]);
  });

  it("keeps every mapped window when the shown workspaces are unknown", () => {
    const windows = mappedWindows(
      [{ class: "anywhere", at: [0, 0], size: [10, 10], mapped: true, workspace: { id: 6 } }],
      visibleWorkspaces([{ activeWorkspace: { id: 0, name: "" } }]),
    );
    expect(windows.map((window) => window.class)).toEqual(["anywhere"]);
  });
});

const scenarioDir = (name: string): string => {
  const dir = NodePath.join("/tmp/opencode", `lock-${name}-${process.pid}`);
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
};

const writeScript = (dir: string, name: string, body: string): void => {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  NodeFS.chmodSync(path, 0o755);
};

// The oracle takes its own PATH: no test has to mutate the process environment.
const onPath = (dir: string) => ({ PATH: dir });

const lockSession: LinuxSession = {
  waylandDisplay: "wayland-1",
  xdgRuntimeDir: "/run/user/1000",
  hyprlandInstance: "sig",
  uid: 1000,
};

describe("sessionLocked", () => {
  it("believes logind's LockedHint when Omarchy's own oracles are gone", async () => {
    const dir = scenarioDir("logind-locked");
    writeScript(dir, "gdbus", 'echo "(<true>,)"');
    expect(await sessionLocked(lockSession, onPath(dir))).toBe(true);
  });

  it("reads an unlocked logind session as unlocked", async () => {
    const dir = scenarioDir("logind-open");
    writeScript(dir, "gdbus", 'echo "(<false>,)"');
    expect(await sessionLocked(lockSession, onPath(dir))).toBe(false);
  });

  it("reports unlocked when the second oracle answers with nothing", async () => {
    const dir = scenarioDir("omarchy-open");
    writeScript(dir, "omarchy-hyprland-session-locked", "exit 0");
    expect(await sessionLocked(lockSession, onPath(dir))).toBe(false);
  });

  it("fails closed when no oracle answers at all", async () => {
    const dir = scenarioDir("no-oracle");
    expect(await sessionLocked(lockSession, onPath(dir))).toBe(true);
  });
});
