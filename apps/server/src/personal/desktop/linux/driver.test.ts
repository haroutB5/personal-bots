// @effect-diagnostics nodeBuiltinImport:off - the fixture writes shell scripts and inspects temp files.
// @effect-diagnostics globalTimers:off - a hold is a real millisecond wait in this fixture test.
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { DesktopHelperError } from "../DesktopHelper.ts";
import { LinuxDesktopDriver } from "./driver.ts";
import { ensureLinuxHelperBuilt } from "./helperBuild.ts";
import { LinuxDesktopHelper } from "./helper.ts";
import type { LinuxSession } from "./session.ts";
import { makeFakeWorld, type FakeWorld } from "./testFixtures.ts";

const root = NodePath.join("/tmp/opencode", `pbdesk-test-${process.pid}`);
const session: LinuxSession = {
  waylandDisplay: "wayland-1",
  xdgRuntimeDir: root,
  hyprlandInstance: "test-instance",
  uid: process.getuid?.() ?? 1000,
};

let world: FakeWorld;
let savedPath: string | undefined;

const makeDriver = () =>
  new LinuxDesktopDriver(session, {
    helperDir: NodePath.join(root, "helper"),
    tempDir: NodePath.join(root, "tmp"),
    stopChord: false,
    helperBinary: world.helperPath,
    log: () => undefined,
  });

beforeAll(() => {
  NodeFS.mkdirSync(root, { recursive: true });
  world = makeFakeWorld(root);
  savedPath = process.env.PATH;
  process.env.PATH = `${world.binDir}:${savedPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
});

describe("Linux helper build", () => {
  it("compiles the embedded C source once and reuses the binary", () => {
    const dir = NodePath.join(root, "real-build");
    const first = ensureLinuxHelperBuilt(dir);
    expect(NodeFS.existsSync(first)).toBe(true);
    expect(NodeFS.statSync(first).size).toBeGreaterThan(1_000);
    expect(ensureLinuxHelperBuilt(dir)).toBe(first);
  }, 120_000);
});

describe("LinuxDesktopDriver", () => {
  it("reports monitors in logical pixels and the focused window", async () => {
    const driver = makeDriver();
    try {
      const info = await driver.request("info");
      const monitors = info.monitors as Array<Record<string, unknown>>;
      expect(monitors[0]?.width).toBe(1536);
      expect(monitors[0]?.height).toBe(960);
      expect(monitors[0]?.primary).toBe(true);
      expect(info.locked).toBe(false);
      expect((info.focusedWindow as { title?: string }).title).toBe("Terminal");
    } finally {
      driver.dispose();
    }
  });

  it("captures a screenshot through grim with the pointer included", async () => {
    const driver = makeDriver();
    try {
      const shot = await driver.request("screenshot", {
        x: 0,
        y: 0,
        width: 1536,
        height: 960,
        outWidth: 768,
        outHeight: 480,
        quality: 80,
      });
      expect(shot.mimeType).toBe("image/jpeg");
      expect(String(shot.data).length).toBeGreaterThan(0);
    } finally {
      driver.dispose();
    }
  });

  it("reports the cursor in logical pixels", async () => {
    const driver = makeDriver();
    try {
      expect(await driver.request("cursor")).toEqual({ x: 100, y: 200 });
    } finally {
      driver.dispose();
    }
  });

  it("serves live-view frames with the monitor's logical size", async () => {
    const driver = makeDriver();
    try {
      const frame = await driver.request("frame", {
        maxWidth: 768,
        maxHeight: 480,
        quality: 70,
      });
      expect(frame.screenWidth).toBe(1536);
      expect(frame.screenHeight).toBe(960);
      expect(frame.regionWidth).toBe(1536);
      expect(String(frame.data).length).toBeGreaterThan(0);
      expect(frame.locked).toBe(false);
    } finally {
      driver.dispose();
    }
  });

  it("maps every pointer and keyboard primitive to the helper protocol", async () => {
    const driver = makeDriver();
    try {
      await driver.request("move", { x: 100, y: 200 });
      await driver.request("click", { x: 100, y: 200, button: "left", count: 2 });
      await driver.request("drag", {
        fromX: 100,
        fromY: 200,
        toX: 300,
        toY: 400,
        button: "left",
      });
      await driver.request("scroll", { dx: 0, dy: -3 });
      await driver.request("type", { text: "hi\nthere" });
      await driver.request("keys", { combos: [[0x11, 0x41]], repeat: 1 });
      await driver.request("button", { button: "right", down: true });
      await driver.request("button", { button: "right", down: false });
      await driver.request("hold", { keys: [0x28], durationMs: 80, repeat: true });
      await driver.request("releaseAll");
    } finally {
      driver.dispose();
    }
    const commands = world.helperCommands();
    expect(commands).toContain("layout gb");
    expect(commands).toContain("move 100 200 1536 960");
    expect(commands).toContain("click left 2 100 200 1536 960");
    expect(commands).toContain("drag 100 200 300 400 1536 960 left 18 200");
    expect(commands).toContain("scroll 0 -3");
    expect(commands).toContain("type hi");
    expect(commands).toContain("type there");
    expect(commands).toContain("key Return down");
    expect(commands).toContain("key Control_L down");
    expect(commands).toContain("key a down");
    expect(commands).toContain("key a up");
    expect(commands).toContain("key Control_L up");
    expect(commands).toContain("button right down");
    expect(commands).toContain("button right up");
    expect(commands).toContain("key Down down");
    expect(commands).toContain("key Down up");
    expect(commands).toContain("releaseall");
  });

  it("lets go of a held key when the press is refused", async () => {
    const driver = makeDriver();
    try {
      await expect(
        driver.request("hold", { keys: [0x27], durationMs: 80, repeat: true }),
      ).rejects.toBeInstanceOf(DesktopHelperError);
    } finally {
      driver.dispose();
    }
    const commands = world.helperCommands();
    expect(commands).toContain("key Right down");
    expect(commands).toContain("key Right up");
  });

  it("refuses desktop input into Brave", async () => {
    world.setActiveWindow({
      address: "0xbrave",
      title: "Brave",
      class: "brave-browser",
      workspace: { id: 2, name: "2" },
      monitor: 0,
    });
    const driver = makeDriver();
    try {
      await expect(driver.request("click", { x: 10, y: 10 })).rejects.toMatchObject({
        code: "user_active",
      });
    } finally {
      world.setActiveWindow({
        address: "0xabc",
        title: "Terminal",
        class: "alacritty",
        workspace: { id: 2, name: "2" },
        monitor: 0,
      });
      driver.dispose();
    }
  });

  it("takes back control after a workspace change the bot did not make", async () => {
    const dir = NodePath.join(root, "hypr", "test-instance");
    NodeFS.mkdirSync(dir, { recursive: true });
    const socketPath = NodePath.join(dir, ".socket2.sock");
    NodeFS.rmSync(socketPath, { force: true });
    const connections: NodeNet.Socket[] = [];
    const server = NodeNet.createServer((socket) => connections.push(socket));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const connected = new Promise<void>((resolve) => server.once("connection", () => resolve()));
    const driver = makeDriver();
    try {
      await connected;
      await driver.request("move", { x: 10, y: 10 });
      connections[0]?.write("workspace>>5\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(driver.request("move", { x: 11, y: 11 })).rejects.toMatchObject({
        code: "user_active",
      });
    } finally {
      driver.dispose();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ignores the bot's own focus change but takes back a later one", async () => {
    const dir = NodePath.join(root, "hypr", "test-instance");
    NodeFS.mkdirSync(dir, { recursive: true });
    const socketPath = NodePath.join(dir, ".socket2.sock");
    NodeFS.rmSync(socketPath, { force: true });
    const connections: NodeNet.Socket[] = [];
    const server = NodeNet.createServer((socket) => connections.push(socket));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const connected = new Promise<void>((resolve) => server.once("connection", () => resolve()));
    const driver = makeDriver();
    try {
      await connected;
      await driver.request("move", { x: 20, y: 20 });
      // Right after the bot's own action: its click may have moved focus.
      connections[0]?.write("activewindowv2>>0xnew\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await driver.request("move", { x: 21, y: 21 });
      // Later, a focus change is the user's.
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      connections[0]?.write("activewindowv2>>0xother\n");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(driver.request("move", { x: 22, y: 22 })).rejects.toMatchObject({
        code: "user_active",
      });
    } finally {
      driver.dispose();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses input while the session is locked", async () => {
    world.setLocked(true);
    const driver = makeDriver();
    try {
      await expect(driver.request("move", { x: 10, y: 10 })).rejects.toMatchObject({
        code: "locked",
      });
    } finally {
      world.setLocked(false);
      driver.dispose();
    }
  });

  it("panic-releases after a helper crash before the next command", async () => {
    const before = world.helperCommands().length;
    const helper = new LinuxDesktopHelper(
      session,
      NodePath.join(root, "helper-panic"),
      "gb",
      world.helperPath,
    );
    try {
      await helper.request("ping");
      // The fake exits on this command, as a crash would.
      await helper.request("crash").catch(() => undefined);
      await helper.request("move", [5, 6, 1536, 960]);
    } finally {
      await helper.dispose();
    }
    const added = world.helperCommands().slice(before);
    const crash = added.indexOf("crash");
    const panic = added.indexOf("releaseall", crash + 1);
    const move = added.indexOf("move 5 6 1536 960", panic + 1);
    expect(crash).toBeGreaterThanOrEqual(0);
    expect(panic).toBeGreaterThan(crash);
    expect(move).toBeGreaterThan(panic);
  });
});
