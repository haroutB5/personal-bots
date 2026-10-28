// @effect-diagnostics nodeBuiltinImport:off - the fixture writes shell scripts and inspects temp files.
// @effect-diagnostics globalTimers:off - a hold is a real millisecond wait in this fixture test.
// @effect-diagnostics globalDate:off - the layout refresh poll is bounded by wall-clock time.
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { DesktopHelperError } from "../DesktopHelper.ts";
import { LinuxDesktopDriver, type LinuxDesktopDriverOptions } from "./driver.ts";
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

const PROFILE_ROOT = NodePath.join(root, "personal", "browser-profiles");
const SHARED_BROWSER_PID = 424242;
const USER_BROWSER_PID = 434343;
const TEMP_CHROMIUM_PID = 444444;
const COMMAND_LINES = new Map<number, string>([
  [
    SHARED_BROWSER_PID,
    `brave --remote-debugging-pipe --user-data-dir=${NodePath.join(PROFILE_ROOT, "default")}`,
  ],
  [USER_BROWSER_PID, "brave --user-data-dir=/home/harout/.config/BraveSoftware/Brave-Browser"],
  [TEMP_CHROMIUM_PID, "chromium --user-data-dir=/tmp/chromium-temp-profile-1234"],
]);

const makeDriver = (overrides: Partial<LinuxDesktopDriverOptions> = {}) =>
  new LinuxDesktopDriver(session, {
    helperDir: NodePath.join(root, "helper"),
    tempDir: NodePath.join(root, "tmp"),
    stopChord: false,
    helperBinary: world.helperPath,
    log: () => undefined,
    sensitiveSites: async () => [],
    sharedBrowserProfileRoots: [PROFILE_ROOT],
    readProcessCommandLine: (pid) => COMMAND_LINES.get(pid) ?? null,
    ...overrides,
  });

/** A browser window the user owns, as Hyprland reports it. */
const userBraveWindow = (overrides: Record<string, unknown> = {}) => ({
  address: "0xuserbrave",
  pid: USER_BROWSER_PID,
  title: "YouTube Music - Brave",
  class: "brave-browser",
  workspace: { id: 2, name: "2" },
  monitor: 0,
  ...overrides,
});

/** The terminal fills the monitor, so any point lands on it by default. */
const TERMINAL_CLIENT = {
  address: "0xabc",
  title: "Terminal",
  class: "alacritty",
  at: [0, 0],
  size: [1536, 960],
  mapped: true,
  hidden: false,
  workspace: { id: 2, name: "2" },
};

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
      // A screenshot can hold anything: the folder is owner-only.
      expect(NodeFS.statSync(NodePath.join(root, "tmp")).mode & 0o777).toBe(0o700);
    } finally {
      driver.dispose();
    }
  });

  it("replaces its own PC banner instead of stacking a new one", async () => {
    const driver = makeDriver();
    try {
      await driver.request("overlay", { text: "Assistant is using your PC" });
      // A screenshot hides the banner and puts it back, which used to create
      // a fresh notification every time (QA's L4).
      await driver.request("screenshot", { x: 0, y: 0, width: 100, height: 100 });
    } finally {
      driver.dispose();
    }
    const banners = NodeFS.readFileSync(world.notifyLog, "utf8")
      .split("\n")
      .filter((line) => line.includes("Assistant is using your PC"));
    expect(banners.length).toBe(2);
    expect(banners[0]).not.toContain("-r");
    expect(banners[1]).toContain("-r 42");
  });

  it("takes the banner off the screen for each screenshot and off for good at the end", async () => {
    // Omarchy's quickshell keeps a card the server closed on screen, so a
    // close-then-recreate left one banner behind per screenshot (QA's B5).
    // Its own dismiss IPC is what removes it; the banner stays one card.
    const offset = NodeFS.readFileSync(world.notifyLog, "utf8").split("\n").length - 1;
    const driver = makeDriver();
    try {
      await driver.request("overlay", { text: "Assistant is using your PC" });
      await driver.request("screenshot", { x: 0, y: 0, width: 100, height: 100 });
      await driver.request("screenshot", { x: 0, y: 0, width: 100, height: 100 });
      await driver.request("overlay", { show: false });
    } finally {
      driver.dispose();
    }
    const lines = NodeFS.readFileSync(world.notifyLog, "utf8")
      .split("\n")
      .slice(offset)
      .filter((line) => line.trim().length > 0);
    const dismisses = lines.filter((line) => line.startsWith("dismiss "));
    // One before each of the two screenshots and one when the session ended;
    // the first show also clears anything a crash left behind.
    expect(dismisses.length).toBe(4);
    expect(dismisses.every((line) => line.endsWith("hbots"))).toBe(true);
    // Every re-show reuses the same replace id, so the cards stay one.
    const banners = lines.filter((line) => line.includes("Assistant is using your PC"));
    expect(banners.length).toBe(3);
    expect(banners.slice(1).every((line) => line.includes("-r 42"))).toBe(true);
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

  it("refuses desktop input into the bots' shared browser, by pid", async () => {
    world.setActiveWindow({
      address: "0xshared",
      pid: SHARED_BROWSER_PID,
      title: "New Tab",
      class: "brave-browser",
      workspace: { id: 2, name: "2" },
      monitor: 0,
    });
    const driver = makeDriver();
    try {
      const error = await driver.request("click", { x: 10, y: 10 }).catch((cause) => cause);
      expect(error).toBeInstanceOf(DesktopHelperError);
      expect(error).toMatchObject({ code: "user_active" });
      expect(String(error.message)).toContain("shared browser");
      expect(String(error.message)).toContain("browser tools");
    } finally {
      world.setActiveWindow(userBraveWindow());
      driver.dispose();
    }
  });

  it("drives the user's own Brave window, including YouTube Music", async () => {
    world.setActiveWindow(userBraveWindow());
    const before = world.helperCommands().length;
    const driver = makeDriver();
    try {
      await driver.request("click", { x: 10, y: 10 });
      await driver.request("type", { text: "hello" });
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
    const commands = world.helperCommands().slice(before);
    expect(commands.some((line) => line.startsWith("click"))).toBe(true);
    expect(commands).toContain("type hello");
  });

  it("drives a Chromium window with a temporary profile", async () => {
    world.setActiveWindow(
      userBraveWindow({ address: "0xchromium", pid: TEMP_CHROMIUM_PID, class: "chromium" }),
    );
    const before = world.helperCommands().length;
    const driver = makeDriver();
    try {
      await driver.request("click", { x: 10, y: 10 });
    } finally {
      world.setActiveWindow(userBraveWindow());
      driver.dispose();
    }
    expect(
      world
        .helperCommands()
        .slice(before)
        .some((line) => line.startsWith("click")),
    ).toBe(true);
  });

  it("drives a Brave PWA window", async () => {
    world.setActiveWindow(userBraveWindow({ class: "brave-abc-Default", title: "Calendar" }));
    const before = world.helperCommands().length;
    const driver = makeDriver();
    try {
      await driver.request("click", { x: 10, y: 10 });
    } finally {
      world.setActiveWindow(userBraveWindow());
      driver.dispose();
    }
    expect(
      world
        .helperCommands()
        .slice(before)
        .some((line) => line.startsWith("click")),
    ).toBe(true);
  });

  it("refuses a window titled with a site the user marked sensitive", async () => {
    world.setActiveWindow(userBraveWindow({ title: "Barclays Online - Brave" }));
    const driver = makeDriver({
      sensitiveSites: async () => [{ origin: "https://bank.example", label: "Barclays" }],
    });
    try {
      const error = await driver.request("click", { x: 10, y: 10 }).catch((cause) => cause);
      expect(error).toMatchObject({ code: "user_active" });
      expect(String(error.message)).toContain("marked sensitive");
    } finally {
      world.setActiveWindow(userBraveWindow());
      driver.dispose();
    }
  });

  it("blocks browser windows when the sensitive list cannot be read", async () => {
    world.setActiveWindow(userBraveWindow());
    const driver = makeDriver({
      sensitiveSites: async () => {
        throw new Error("database is locked");
      },
    });
    try {
      const error = await driver.request("click", { x: 10, y: 10 }).catch((cause) => cause);
      expect(error).toMatchObject({ code: "user_active" });
      expect(String(error.message)).toContain("could not be checked");
    } finally {
      driver.dispose();
    }
  });

  it("drives a point over the user's Brave PWA while a text editor has focus", async () => {
    world.setClients([
      TERMINAL_CLIENT,
      {
        address: "0xbrave",
        pid: USER_BROWSER_PID,
        title: "Calendar",
        class: "brave-abc-Default",
        at: [100, 100],
        size: [400, 300],
        mapped: true,
        hidden: false,
        workspace: { id: 2, name: "2" },
      },
    ]);
    const before = world.helperCommands().length;
    const driver = makeDriver();
    try {
      // Focus is the terminal; the click point is inside the user's PWA.
      await driver.request("click", { x: 200, y: 150 });
      await driver.request("drag", { fromX: 10, fromY: 10, toX: 200, toY: 150 });
    } finally {
      world.setClients([TERMINAL_CLIENT]);
      driver.dispose();
    }
    const commands = world.helperCommands().slice(before);
    expect(commands.some((line) => line.startsWith("click"))).toBe(true);
    expect(commands.some((line) => line.startsWith("drag"))).toBe(true);
  });

  it("refuses a point over a window titled with a sensitive site", async () => {
    world.setClients([
      TERMINAL_CLIENT,
      {
        address: "0xbrave",
        pid: USER_BROWSER_PID,
        title: "Barclays Online - Brave",
        class: "brave-browser",
        at: [100, 100],
        size: [400, 300],
        mapped: true,
        hidden: false,
        workspace: { id: 2, name: "2" },
      },
    ]);
    const before = world.helperCommands().length;
    const driver = makeDriver({
      sensitiveSites: async () => [{ origin: "https://bank.example", label: "Barclays" }],
    });
    try {
      await expect(driver.request("click", { x: 200, y: 150 })).rejects.toMatchObject({
        code: "point_blocked",
      });
      await expect(
        driver.request("drag", { fromX: 10, fromY: 10, toX: 200, toY: 150 }),
      ).rejects.toMatchObject({ code: "point_blocked" });
    } finally {
      world.setClients([TERMINAL_CLIENT]);
      driver.dispose();
    }
    expect(
      world
        .helperCommands()
        .slice(before)
        .some((line) => line.startsWith("click")),
    ).toBe(false);
  });

  it("refuses a point over the bots' shared browser while a text editor has focus", async () => {
    world.setClients([
      TERMINAL_CLIENT,
      {
        address: "0xshared",
        pid: SHARED_BROWSER_PID,
        title: "New Tab",
        class: "brave-browser",
        at: [100, 100],
        size: [400, 300],
        mapped: true,
        hidden: false,
        workspace: { id: 2, name: "2" },
      },
    ]);
    const before = world.helperCommands().length;
    const driver = makeDriver();
    try {
      const error = await driver.request("click", { x: 200, y: 150 }).catch((cause) => cause);
      expect(error).toMatchObject({ code: "point_blocked" });
      expect(String(error.message)).toContain("shared browser");
    } finally {
      world.setClients([TERMINAL_CLIENT]);
      driver.dispose();
    }
    expect(
      world
        .helperCommands()
        .slice(before)
        .some((line) => line.startsWith("click")),
    ).toBe(false);
  });

  it("ignores a Brave window on a workspace no monitor is showing", async () => {
    // QA's B3: Hyprland reports a loaded workspace's windows as mapped too, so
    // a browser on workspace 6 used to block a click at the same spot on the
    // active workspace 2.
    world.setClients([
      TERMINAL_CLIENT,
      {
        address: "0xbrave",
        pid: USER_BROWSER_PID,
        title: "Calendar",
        class: "brave-abc-Default",
        at: [100, 100],
        size: [400, 300],
        mapped: true,
        hidden: false,
        workspace: { id: 6, name: "6" },
      },
    ]);
    const before = world.helperCommands().length;
    const driver = makeDriver();
    try {
      await driver.request("click", { x: 200, y: 150 });
      expect(
        world
          .helperCommands()
          .slice(before)
          .some((line) => line.startsWith("click")),
      ).toBe(true);
    } finally {
      driver.dispose();
    }
  });

  it("blocks the same point once the monitor shows that workspace", async () => {
    // The point guard follows the monitor's active workspace, not a stale
    // window list: switch the monitor to workspace 6 and the shared browser
    // is on screen and must block.
    world.setClients([
      TERMINAL_CLIENT,
      {
        address: "0xshared",
        pid: SHARED_BROWSER_PID,
        title: "New Tab",
        class: "brave-browser",
        at: [100, 100],
        size: [400, 300],
        mapped: true,
        hidden: false,
        workspace: { id: 6, name: "6" },
      },
    ]);
    world.setMonitors([
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
        activeWorkspace: { id: 6, name: "6" },
        specialWorkspace: { id: 0, name: "" },
      },
    ]);
    const driver = makeDriver();
    try {
      await expect(driver.request("click", { x: 200, y: 150 })).rejects.toMatchObject({
        code: "point_blocked",
      });
    } finally {
      world.setClients([TERMINAL_CLIENT]);
      world.setMonitors([
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
          activeWorkspace: { id: 2, name: "2" },
          specialWorkspace: { id: 0, name: "" },
        },
      ]);
      driver.dispose();
    }
  });

  it("keeps a pinned shared-browser window in the guard, whatever workspace it sits on", async () => {
    world.setClients([
      TERMINAL_CLIENT,
      {
        address: "0xshared",
        pid: SHARED_BROWSER_PID,
        title: "New Tab",
        class: "brave-browser",
        at: [100, 100],
        size: [400, 300],
        mapped: true,
        hidden: false,
        pinned: true,
        workspace: { id: 6, name: "6" },
      },
    ]);
    const driver = makeDriver();
    try {
      await expect(driver.request("click", { x: 200, y: 150 })).rejects.toMatchObject({
        code: "point_blocked",
      });
    } finally {
      world.setClients([TERMINAL_CLIENT]);
      driver.dispose();
    }
  });

  it("refuses a point over a password manager, by any namespaced class", async () => {
    world.setClients([
      TERMINAL_CLIENT,
      {
        address: "0xkeepass",
        class: "org.keepassxc.KeePassXC",
        at: [200, 200],
        size: [300, 200],
        mapped: true,
        hidden: false,
        workspace: { id: 2, name: "2" },
      },
    ]);
    const before = world.helperCommands().length;
    const driver = makeDriver();
    try {
      await expect(driver.request("click", { x: 250, y: 250 })).rejects.toMatchObject({
        code: "point_blocked",
      });
    } finally {
      world.setClients([TERMINAL_CLIENT]);
      driver.dispose();
    }
    expect(
      world
        .helperCommands()
        .slice(before)
        .some((line) => line.startsWith("click")),
    ).toBe(false);
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
      // One-shot: a retry without a fresh screenshot is refused as well, so a
      // second look at the same state cannot slip through.
      await expect(driver.request("move", { x: 12, y: 12 })).rejects.toMatchObject({
        code: "user_active",
      });
      // A fresh screenshot is how the bot acknowledges the take-back.
      await driver.request("screenshot", { x: 0, y: 0, width: 100, height: 100 });
      await driver.request("move", { x: 13, y: 13 });
    } finally {
      driver.dispose();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lets go of a held key at once when the user switches workspace", async () => {
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
      // QA's finding: a 20 s hold ignored a workspace change and kept repeating.
      const baseline = world.helperCommands().length;
      const hold = driver.request("hold", { keys: [0x28], durationMs: 5_000, repeat: true });
      // Claim the rejection now: it waits until the workspace event below.
      const outcome = hold.then(
        () => null,
        (error: unknown) => error,
      );
      const pressedBy = Date.now() + 2_000;
      while (!world.helperCommands().slice(baseline).includes("key Down down")) {
        if (Date.now() > pressedBy) throw new Error("the hold never pressed Down");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const before = world.helperCommands().length;
      const interruptedAt = Date.now();
      connections[0]?.write("workspace>>5\n");
      let releasedAfter = Number.POSITIVE_INFINITY;
      const deadline = interruptedAt + 2_000;
      for (;;) {
        if (world.helperCommands().slice(before).includes("releaseall")) {
          releasedAfter = Date.now() - interruptedAt;
          break;
        }
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // The release must not wait for the rest of the hold.
      expect(releasedAfter).toBeLessThan(500);
      expect(await outcome).toMatchObject({ code: "taken_over" });
      const after = world.helperCommands().slice(before);
      expect(after).toContain("key Down up");
      // M2: the next action stays blocked until a fresh screenshot.
      await expect(driver.request("move", { x: 11, y: 11 })).rejects.toMatchObject({
        code: "user_active",
      });
      await driver.request("screenshot", { x: 0, y: 0, width: 100, height: 100 });
      await driver.request("move", { x: 12, y: 12 });
    } finally {
      driver.dispose();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lets go of a held mouse button when the user switches workspace", async () => {
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
      await driver.request("button", { button: "left", down: true });
      const before = world.helperCommands().length;
      connections[0]?.write("workspace>>5\n");
      const deadline = Date.now() + 2_000;
      while (!world.helperCommands().slice(before).includes("releaseall")) {
        if (Date.now() > deadline) throw new Error("the held button was never let go");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(driver.request("move", { x: 11, y: 11 })).rejects.toMatchObject({
        code: "user_active",
      });
      await driver.request("screenshot", { x: 0, y: 0, width: 100, height: 100 });
      await driver.request("move", { x: 12, y: 12 });
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
      // Later than the 300 ms grace, a focus change is the user's.
      await new Promise((resolve) => setTimeout(resolve, 500));
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

  it("ignores the helper's own virtual keyboard layout event and keeps typing", async () => {
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
      // What Hyprland sends when the helper's own virtual keyboard is chosen:
      // both fields are the device name, not a layout.
      connections[0]?.write(
        "activelayout>>hl-virtual-keyboard-pbdesk-wl-99,hl-virtual-keyboard-pbdesk-wl-99\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      const before = world.helperCommands().length;
      await driver.request("keys", { combos: [[0x41]] });
      const added = world.helperCommands().slice(before);
      // The key still goes out, and no layout was ever named after the device.
      expect(added).toContain("key a down");
      expect(world.helperCommands().some((line) => line.startsWith("layout hl-"))).toBe(false);
      expect(world.helperCommands().some((line) => line.includes("pbdesk-wl-99"))).toBe(false);
    } finally {
      driver.dispose();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("re-reads the layout on a real keyboard event instead of parsing its name", async () => {
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
      world.setLayout("fr");
      connections[0]?.write("activelayout>>kbd-1,French (US)\n");
      const started = Date.now();
      while (!world.helperCommands().includes("layout fr")) {
        if (Date.now() - started > 2_000) throw new Error("the layout was never refreshed");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The display name never reaches the helper: the option value does.
      expect(world.helperCommands().some((line) => line.includes("French"))).toBe(false);
    } finally {
      world.setLayout("gb");
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

describe("Linux helper environment", () => {
  it("starts the helper with the five Wayland variables and nothing else", async () => {
    const dump = NodePath.join(root, "helper-env.txt");
    const binary = NodePath.join(root, "env-pbdesk-wl");
    NodeFS.writeFileSync(
      binary,
      `#!/bin/sh
env > "${dump}"
echo "ready layout=$1 pid=$$"
while IFS= read -r line; do
  id=\${line%% *}
  echo "ok $id 1"
done
`,
      "utf8",
    );
    NodeFS.chmodSync(binary, 0o755);
    process.env.PB_TEST_SECRET = "leak-me";
    const helper = new LinuxDesktopHelper(session, NodePath.join(root, "helper-env"), "gb", binary);
    try {
      await helper.request("ping");
    } finally {
      await helper.dispose();
      delete process.env.PB_TEST_SECRET;
    }
    const env = NodeFS.readFileSync(dump, "utf8");
    // Nothing of the bot's environment travels into a compositor client.
    expect(env).not.toContain("leak-me");
    expect(env).not.toContain("PB_TEST_SECRET");
    expect(env).toContain(`XDG_RUNTIME_DIR=${session.xdgRuntimeDir}\n`);
    expect(env).toContain("WAYLAND_DISPLAY=wayland-1");
    expect(env).toContain("HYPRLAND_INSTANCE_SIGNATURE=test-instance");
    const carried = env
      .split("\n")
      // `_`, `PWD` and `SHLVL` are set by the shell that ran the script, not
      // inherited from hbots.
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line) && !/^(_|PWD|SHLVL)=/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")))
      .sort();
    expect(carried).toEqual([
      "HOME",
      "HYPRLAND_INSTANCE_SIGNATURE",
      "PATH",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
    ]);
  });
});

describe("Linux banner environment", () => {
  it("passes notify-send the variables Omarchy's notification IPC needs", async () => {
    // The live service has both (checked in /proc/<pid>/environ); the throwaway
    // helper dropped them, which QA saw as three stacked banners (B5). The
    // banner commands get the service's environment, so prove they carry it.
    const saved = {
      OMARCHY_PATH: process.env.OMARCHY_PATH,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    };
    delete process.env.OMARCHY_PATH;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    process.env.OMARCHY_PATH = "/usr/share/omarchy";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    const driver = makeDriver();
    try {
      await driver.request("overlay", { text: "Assistant is using your PC" });
    } finally {
      driver.dispose();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const env = NodeFS.readFileSync(NodePath.join(root, "notify-env.log"), "utf8");
    expect(env).toContain("OMARCHY_PATH=/usr/share/omarchy");
    expect(env).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus");
  });
});
