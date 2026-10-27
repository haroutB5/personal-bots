// @effect-diagnostics nodeBuiltinImport:off - grim, hyprctl and notify-send are the platform, driven as child processes.
// @effect-diagnostics globalTimers:off - coalescing, event windows and holds use plain timers.
// @effect-diagnostics globalDate:off - the takeover window uses a monotonic millisecond clock.
/**
 * The Linux desktop driver: the same `DesktopDriver` seam as Windows, backed by
 * Hyprland, grim and one long-lived `pbdesk-wl`.
 *
 * Everything the driver reports or accepts is in **logical layout pixels**,
 * the unit `hyprctl cursorpos`, `hyprctl monitors` origins and the virtual
 * pointer all use (SPEC.md 5.1). Screenshot pixels are mapped to and from that
 * space by `desktopGeometry.ts`, unchanged.
 *
 * Safety rails live here, not in the helper (SPEC.md 9):
 * - no input while the session is locked, the screen is off, or the screensaver
 *   is up;
 * - no desktop input while Brave (or another Chromium) is focused: the shared
 *   browser has a lease and a sensitive-site pause the desktop would bypass;
 * - no input into a password manager by window class;
 * - no input at a point where a mapped browser or password-manager window sits,
 *   whatever holds focus: a click can land on Brave while a text editor is
 *   focused;
 * - take-back: a workspace change the bot did not make, or a focus change to a
 *   window it did not act on more than 300 ms after its last action, refuses the
 *   next input with `user_active` until a fresh screenshot acknowledges it;
 * - every failure and every restart panic-releases held keys and buttons.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { type DesktopDriver, DesktopHelperError } from "../DesktopHelper.ts";
import { unionRect, type DesktopRect } from "../desktopGeometry.ts";
import type { KeyEntry } from "../desktopKeys.ts";
import { LinuxScreenCapture } from "./capture.ts";
import { LinuxDesktopHelper } from "./helper.ts";
import { isModifierEntry, keysymName } from "./keyMap.ts";
import {
  activeWindow,
  type ActiveWindow,
  discoverLinuxSession,
  hyprctl,
  hyprctlJson,
  type LinuxSession,
  type LogicalMonitor,
  logicalMonitors,
  type MappedWindow,
  mappedWindows,
  type RawActiveWindow,
  type RawClient,
  runCommand,
  sessionEnv,
  sessionLocked,
  type VisibleWorkspaces,
  visibleWorkspaces,
} from "./session.ts";

export const LINUX_STOP_HOTKEY = "Super+Shift+F12";
const STOP_CHORD = "SUPER + SHIFT + F12";
/** A focus/workspace event this soon after the bot's own action is the bot's. */
const TAKEOVER_GRACE_MS = 300;
const MONITOR_TTL_MS = 500;
const WINDOW_TTL_MS = 1_000;
const LOCK_TTL_MS = 1_000;
/** Which workspaces are on screen changes far less often than the clock ticks. */
const VISIBLE_TTL_MS = 500;

/** Windows that hold credentials: never type into them (best effort, by class). */
const PASSWORD_MANAGER_CLASSES = [
  "1password",
  "bitwarden",
  "keepassxc",
  "keepass",
  "enpass",
  "proton pass",
  "protonpass",
];
/**
 * Matched by prefix, not equality: a Brave PWA is `brave-<app>-Default`, and
 * the focus guard and the point guard must both see it as the shared browser.
 */
const BROWSER_CLASS_PREFIXES = ["brave", "chromium", "chrome", "google-chrome"];

const isBrowserClass = (windowClass: string): boolean =>
  BROWSER_CLASS_PREFIXES.some((prefix) => windowClass.startsWith(prefix));

/** Matched by containment: a password manager's class is namespaced. */
const isPasswordManagerClass = (windowClass: string): boolean =>
  PASSWORD_MANAGER_CLASSES.some((name) => windowClass.includes(name));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Number(value) || fallback;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export interface LinuxDesktopDriverOptions {
  /** Where the compiled helper and its sources live. */
  readonly helperDir: string;
  /** Where captures are written before being read back. */
  readonly tempDir: string;
  /** Register the runtime stop chord (off in tests and throwaway roots). */
  readonly stopChord?: boolean;
  /** A prebuilt helper; production builds it from the embedded source. */
  readonly helperBinary?: string;
  readonly log?: (line: string) => void;
}

interface ScreenState {
  monitors: LogicalMonitor[];
  at: number;
}

export class LinuxDesktopDriver implements DesktopDriver {
  readonly stopHotkey = LINUX_STOP_HOTKEY;
  private readonly helper: LinuxDesktopHelper;
  private readonly capture: LinuxScreenCapture;
  private readonly killListeners: Array<() => void> = [];
  private readonly log: (line: string) => void;
  private monitorsCache: ScreenState | null = null;
  private workspaceCache: { workspaces: VisibleWorkspaces; at: number } | null = null;
  private layoutRefresh: Promise<void> | null = null;
  private windowCache: { window: ActiveWindow | null; at: number } | null = null;
  private lockCache: { locked: boolean; at: number } | null = null;
  private events: NodeNet.Socket | null = null;
  private stopWatch: NodeFS.StatWatcher | null = null;
  private stopFile: string | null = null;
  private overlayId: number | null = null;
  /** The notification id to replace, so a session never stacks banners. */
  private overlayReplaceId: number | null = null;
  private overlayText: string | null = null;
  private overlayCapturable = false;
  private disposed = false;
  private lastBotActionAt = 0;
  private botWindowAddress = "";
  private botWorkspace = "";
  private userActiveAt = 0;
  private configReloads = 0;

  private readonly session: LinuxSession;
  private readonly options: LinuxDesktopDriverOptions;

  constructor(session: LinuxSession, options: LinuxDesktopDriverOptions) {
    this.session = session;
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.capture = new LinuxScreenCapture(session, options.tempDir);
    this.helper = new LinuxDesktopHelper(
      session,
      options.helperDir,
      this.layout,
      options.helperBinary ?? null,
    );
    // A helper crash is not the user taking control: the action fails and the
    // next one starts a fresh helper with a panic release. Only the stop chord
    // and the app's Stop end a bot.
    this.watchEvents();
    if (options.stopChord !== false) this.armStop();
  }

  private layout = "us";
  private layoutKnown = false;

  private async ensureLayout(): Promise<void> {
    if (this.layoutKnown) return;
    try {
      const option = await hyprctlJson<{ str?: string }>(this.session, [
        "getoption",
        "input:kb_layout",
      ]);
      const value = str(option.str).split(",")[0]?.trim();
      if (value && value.length > 0) this.layout = value;
      this.layoutKnown = true;
      await this.helper.request("layout", [this.layout], 5_000).catch(() => undefined);
    } catch {
      // Keep "us"; typing still works for plain text and fails loudly otherwise.
    }
  }

  /**
   * A layout change is re-read from Hyprland, once per burst of keyboard
   * events, and only sent to the helper when it really changed: every
   * `layout` command rebuilds the keymap and releases whatever is held.
   */
  private scheduleLayoutRefresh(): void {
    if (this.layoutRefresh !== null) return;
    this.layoutRefresh = this.refreshLayout().finally(() => {
      this.layoutRefresh = null;
    });
  }

  private async refreshLayout(): Promise<void> {
    try {
      const option = await hyprctlJson<{ str?: string }>(this.session, [
        "getoption",
        "input:kb_layout",
      ]);
      const value = str(option.str).split(",")[0]?.trim() ?? "";
      if (value.length === 0) return;
      this.layoutKnown = true;
      if (value === this.layout) return;
      this.layout = value;
      if (this.helper.running) await this.helper.request("layout", [value], 5_000);
    } catch {
      // Keep the layout in use; the next keyboard event tries again.
    }
  }

  onKill(listener: () => void): void {
    this.killListeners.push(listener);
  }

  private async monitors(): Promise<LogicalMonitor[]> {
    const now = Date.now();
    if (this.monitorsCache !== null && now - this.monitorsCache.at < MONITOR_TTL_MS) {
      return this.monitorsCache.monitors;
    }
    const raw = await hyprctlJson<Array<Record<string, unknown>>>(this.session, ["monitors"]);
    const monitors = logicalMonitors(raw);
    this.monitorsCache = { monitors, at: now };
    return monitors;
  }

  private async focusedWindow(): Promise<ActiveWindow | null> {
    const now = Date.now();
    if (this.windowCache !== null && now - this.windowCache.at < WINDOW_TTL_MS) {
      return this.windowCache.window;
    }
    let window: ActiveWindow | null = null;
    try {
      const raw = await hyprctlJson<RawActiveWindow>(this.session, ["activewindow"]);
      window = activeWindow(raw);
    } catch {
      window = null;
    }
    this.windowCache = { window, at: now };
    return window;
  }

  private async locked(): Promise<boolean> {
    const now = Date.now();
    if (this.lockCache !== null && now - this.lockCache.at < LOCK_TTL_MS) {
      return this.lockCache.locked;
    }
    const locked = await sessionLocked(this.session);
    this.lockCache = { locked, at: now };
    return locked;
  }

  /** Last line of defence before anything is injected; never called for release. */
  private async guardInput(): Promise<void> {
    if (await this.locked()) {
      throw new DesktopHelperError(
        "locked",
        "The PC is locked. Nothing was clicked or typed. Ask the user to unlock it; never try to unlock it or type a password.",
      );
    }
    const monitors = await this.monitors();
    if (monitors.every((monitor) => !monitor.dpmsStatus)) {
      throw new DesktopHelperError(
        "locked",
        "The screen is off. Nothing was clicked or typed. Wait for the user to turn it back on.",
      );
    }
    // Always ask Hyprland now: a cached focus is how a take-back was missed.
    this.windowCache = null;
    const window = await this.focusedWindow();
    const windowClass = window?.class.toLowerCase() ?? "";
    if (windowClass === "org.omarchy.screensaver") {
      throw new DesktopHelperError(
        "user_active",
        "The screensaver is up, so the user is away. Nothing was clicked or typed; do not dismiss it.",
      );
    }
    if (isBrowserClass(windowClass)) {
      throw new DesktopHelperError(
        "user_active",
        "Brave is the shared browser. Use the browser tools so the lease and the sensitive-site pause apply. The desktop cannot drive it.",
      );
    }
    if (isPasswordManagerClass(windowClass)) {
      throw new DesktopHelperError(
        "user_active",
        "That window is a password manager. The desktop tools never type or click in one; ask the user to do it.",
      );
    }
    if (this.userActiveAt !== 0 && this.userActiveAt >= this.lastBotActionAt) {
      // One-shot: it stays set until a fresh screenshot acknowledges it, so a
      // retry cannot slip through on a second read of the same state.
      throw new DesktopHelperError(
        "user_active",
        "The user is using the PC (they switched window or workspace), so nothing was done. Take a fresh screenshot, then try again; if they keep using it, ask them whether to continue.",
      );
    }
  }

  /**
   * The window under the point decides, not the focused one: a click can land
   * on Brave or a password manager while a text editor keeps focus.
   */
  private async guardPoint(point: { readonly x: number; readonly y: number }): Promise<void> {
    const { union } = await this.extents();
    const x = Math.round(point.x) - union.x;
    const y = Math.round(point.y) - union.y;
    const windows = await this.mappedWindows();
    const under = windows.filter(
      (window) =>
        x >= window.x &&
        x < window.x + window.width &&
        y >= window.y &&
        y < window.y + window.height,
    );
    if (under.some((window) => isBrowserClass(window.class.toLowerCase()))) {
      throw new DesktopHelperError(
        "point_blocked",
        "Brave is the shared browser and a browser window is under that point. Use the browser tools so the lease and the sensitive-site pause apply. The desktop cannot click it.",
      );
    }
    if (under.some((window) => isPasswordManagerClass(window.class.toLowerCase()))) {
      throw new DesktopHelperError(
        "point_blocked",
        "A password manager window is under that point. The desktop tools never type or click in one; ask the user to do it.",
      );
    }
  }

  /** Every window Hyprland has mapped; a hidden workspace contributes none. */
  private async mappedWindows(): Promise<MappedWindow[]> {
    try {
      // `clients` alone cannot say which workspace is on screen: Hyprland
      // reports a loaded workspace's windows as mapped too (QA's B3). The
      // monitors' active and shown special workspaces are the answer.
      const [raw, shown] = await Promise.all([
        hyprctlJson<ReadonlyArray<RawClient>>(this.session, ["clients"]),
        this.visibleWorkspaces(),
      ]);
      return mappedWindows(Array.isArray(raw) ? raw : [], shown);
    } catch (error) {
      // The point guard exists to keep Brave's lease honest. If the window list
      // cannot be read, refusing is the safe side of that decision.
      throw new DesktopHelperError(
        "unavailable",
        `The windows under the pointer could not be checked, so nothing was clicked: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The workspaces on screen, from `hyprctl monitors`. */
  private async visibleWorkspaces(): Promise<VisibleWorkspaces> {
    const now = Date.now();
    if (this.workspaceCache !== null && now - this.workspaceCache.at < VISIBLE_TTL_MS) {
      return this.workspaceCache.workspaces;
    }
    const monitors = await hyprctlJson<
      ReadonlyArray<{
        readonly activeWorkspace?: { readonly id?: number; readonly name?: string };
        readonly specialWorkspace?: { readonly id?: number; readonly name?: string };
      }>
    >(this.session, ["monitors"]);
    const workspaces = visibleWorkspaces(Array.isArray(monitors) ? monitors : []);
    this.workspaceCache = { workspaces, at: now };
    return workspaces;
  }

  private noteBotAction(): void {
    this.lastBotActionAt = Date.now();
    this.botWindowAddress = this.windowCache?.window?.address ?? "";
    this.botWorkspace = this.windowCache?.window?.workspace ?? "";
  }

  /** Watches Hyprland's event socket for take-back and layout/reload changes. */
  private watchEvents(): void {
    if (this.events !== null) return;
    const socket = NodePath.join(
      this.session.xdgRuntimeDir,
      "hypr",
      this.session.hyprlandInstance,
      ".socket2.sock",
    );
    if (!NodeFS.existsSync(socket)) return;
    const connection = NodeNet.connect(socket);
    this.events = connection;
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const separator = line.indexOf(">>");
        if (separator < 0) continue;
        const event = line.slice(0, separator);
        const detail = line.slice(separator + 2);
        this.onEvent(event, detail);
      }
    });
    connection.on("error", () => {
      this.events = null;
    });
    connection.on("close", () => {
      this.events = null;
    });
  }

  private onEvent(event: string, detail: string): void {
    if (event.startsWith("activewindow")) {
      this.windowCache = null;
      const address = detail.split(",")[0]?.trim() ?? "";
      if (address.length === 0 || address === this.botWindowAddress) return;
      if (Date.now() - this.lastBotActionAt > TAKEOVER_GRACE_MS) {
        this.userActiveAt = Date.now();
      }
      return;
    }
    if (event.startsWith("workspace")) {
      this.windowCache = null;
      this.workspaceCache = null;
      const workspace = detail.split(",")[0]?.trim() ?? "";
      if (workspace.length > 0 && workspace !== this.botWorkspace) {
        this.userActiveAt = Date.now();
      }
      return;
    }
    if (event === "monitoradded" || event === "monitorremoved") {
      this.monitorsCache = null;
      this.workspaceCache = null;
      return;
    }
    if (event === "focusedmon") {
      // Each monitor's active workspace is its own; a monitor switch does not
      // always send `workspace`.
      this.workspaceCache = null;
      return;
    }
    if (event === "activelayout") {
      // Hyprland sends "KEYBOARD,LAYOUT". The first field is the device name:
      // the helper's own virtual keyboard reports itself there, and treating
      // that name as a layout tore the keymap down and crashed the next key
      // (QA's B1). Ignore virtual keyboards and ask Hyprland for the real
      // layout instead of parsing a display name.
      const keyboard = detail.split(",")[0]?.trim() ?? "";
      if (keyboard.startsWith("hl-virtual-keyboard") || keyboard.includes("pbdesk-wl")) return;
      this.scheduleLayoutRefresh();
      return;
    }
    if (event === "configreloaded") {
      this.configReloads += 1;
      this.monitorsCache = null;
      this.workspaceCache = null;
      if (this.options.stopChord !== false) this.armStop();
    }
  }

  /**
   * The stop chord is a runtime bind (SPEC.md 8.4): nothing is written to
   * hyprland.conf, and a config reload re-registers it. The bind touches a
   * file the server watches, which is robust to Hyprland's quoting rules.
   */
  private armStop(): void {
    const dir = NodePath.join(this.session.xdgRuntimeDir, "hbots-desktop");
    try {
      NodeFS.mkdirSync(dir, { recursive: true });
      const file = NodePath.join(dir, "stop.trigger");
      if (this.stopFile === null) {
        NodeFS.writeFileSync(file, "", { flag: "a" });
        this.stopFile = file;
        let last = NodeFS.statSync(file).mtimeMs;
        this.stopWatch = NodeFS.watchFile(file, { interval: 400 }, (current) => {
          if (current.mtimeMs === last) return;
          last = current.mtimeMs;
          if (this.disposed) return;
          this.log("desktop linux: stop chord pressed");
          for (const listener of this.killListeners) listener();
        });
      }
      // Re-register on every config reload; it is runtime-only, never written
      // to hyprland.conf.
      const lua = `hl.bind("${STOP_CHORD}", function() hl.exec_cmd("touch ${file}") end)`;
      void hyprctl(this.session, ["eval", lua], 5_000).catch((error: unknown) => {
        this.log(
          `desktop linux: could not register the stop chord: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      this.log(
        `desktop linux: stop chord unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Closes the banner around one tool screenshot when it would otherwise be
   * captured, then shows it again. The live view never does this: closing and
   * reopening a notification five times a second would flicker.
   */
  private async withOverlayHidden<T>(run: () => Promise<T>): Promise<T> {
    if (this.overlayCapturable || this.overlayId === null) return run();
    const id = this.overlayId;
    this.overlayId = null;
    await this.closeNotification(id);
    try {
      return await run();
    } finally {
      if (!this.disposed && this.overlayText !== null) await this.showOverlay(this.overlayText);
    }
  }

  private async closeNotification(id: number): Promise<void> {
    await runCommand(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.Notifications",
        "--object-path",
        "/org/freedesktop/Notifications",
        "--method",
        "org.freedesktop.Notifications.CloseNotification",
        String(id),
      ],
      { env: sessionEnv(this.session), timeoutMs: 3_000 },
    ).catch(() => undefined);
  }

  private async showOverlay(text: string): Promise<void> {
    this.overlayText = text;
    if (this.overlayId !== null) return;
    try {
      const result = await runCommand(
        "notify-send",
        [
          "-u",
          "critical",
          "-t",
          "0",
          "-p",
          // Replacing the last banner is what keeps one on screen instead of
          // a stack of them after a run of screenshots (QA's L4).
          ...(this.overlayReplaceId === null ? [] : ["-r", String(this.overlayReplaceId)]),
          "--app-name=hbots",
          "hbots",
          text,
        ],
        { env: sessionEnv(this.session), timeoutMs: 5_000 },
      );
      if (result.code === 0) {
        const id = Number.parseInt(result.stdout.trim(), 10);
        if (Number.isFinite(id)) {
          this.overlayId = id;
          this.overlayReplaceId = id;
          return;
        }
      }
    } catch {
      // Fall through to the compositor's own notification.
    }
    await hyprctl(this.session, ["notify", "1", "8000", "0", text], 5_000).catch(() => undefined);
  }

  /** The union of every monitor, in logical pixels, and a point relative to it. */
  private async extents(): Promise<{ union: DesktopRect; monitors: LogicalMonitor[] }> {
    const monitors = await this.monitors();
    return { union: unionRect(monitors), monitors };
  }

  private async helperPoint(
    x: number,
    y: number,
  ): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    const { union } = await this.extents();
    return {
      x: Math.max(0, Math.min(union.width - 1, Math.round(x - union.x))),
      y: Math.max(0, Math.min(union.height - 1, Math.round(y - union.y))),
      width: Math.max(1, Math.round(union.width)),
      height: Math.max(1, Math.round(union.height)),
    };
  }

  private async holdModifiers(modifiers: ReadonlyArray<number> | undefined): Promise<string[]> {
    const names: string[] = [];
    for (const vk of modifiers ?? []) {
      const name = keysymName(vk);
      await this.helper.request("key", [name, "down"], 5_000);
      names.push(name);
    }
    return names;
  }

  private async releaseModifiers(names: ReadonlyArray<string>): Promise<void> {
    for (const name of [...names].reverse()) {
      await this.helper.request("key", [name, "up"], 5_000).catch(() => undefined);
    }
  }

  private async keyChord(combo: ReadonlyArray<KeyEntry>): Promise<void> {
    const modifiers = combo.filter(isModifierEntry);
    const mains = combo.filter((entry) => !isModifierEntry(entry));
    const down: string[] = [];
    try {
      for (const entry of modifiers) {
        const name = keysymName(entry);
        await this.helper.request("key", [name, "down"], 5_000);
        down.push(name);
      }
      if (mains.length === 0) {
        await sleep(10);
      }
      for (const entry of mains) {
        const name = keysymName(entry);
        await this.helper.request("key", [name, "down"], 5_000);
        await this.helper.request("key", [name, "up"], 5_000);
      }
    } finally {
      await this.releaseModifiers(down);
    }
  }

  private async screenshot(
    params: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.withOverlayHidden(async () => {
      const shot = await this.capture.capture({
        x: num(params.x),
        y: num(params.y),
        width: num(params.width, 1),
        height: num(params.height, 1),
        quality: num(params.quality, 80),
        ...(params.outWidth === undefined ? {} : { outWidth: num(params.outWidth) }),
        ...(params.outHeight === undefined ? {} : { outHeight: num(params.outHeight) }),
      });
      return { mimeType: "image/jpeg", data: shot.data, width: shot.width, height: shot.height };
    });
  }

  async request(
    cmd: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    if (this.disposed) {
      throw new DesktopHelperError("unavailable", "The desktop driver is shut down.");
    }
    switch (cmd) {
      case "info": {
        this.watchEvents();
        const monitors = await this.monitors();
        const locked = await this.locked();
        const window = await this.focusedWindow();
        const displayOff = monitors.every((monitor) => !monitor.dpmsStatus);
        return {
          monitors: monitors.map((monitor) => ({
            index: monitor.index,
            primary: monitor.primary,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            dpi: monitor.dpi,
            name: monitor.name,
            scale: monitor.scale,
            focused: monitor.focused,
            dpmsStatus: monitor.dpmsStatus,
          })),
          locked,
          displayOff,
          screensaver: window?.class === "org.omarchy.screensaver",
          focusedWindow:
            window === null
              ? null
              : { title: window.title, class: window.class, address: window.address },
        };
      }
      case "screenshot": {
        const shot = await this.screenshot(params);
        // A fresh screenshot acknowledges a take-back: the bot has seen that
        // the user is using the PC, and the next input may try again.
        this.userActiveAt = 0;
        return shot;
      }
      case "frame": {
        const monitors = await this.monitors();
        const primary = monitors.find((monitor) => monitor.primary) ?? monitors[0];
        if (primary === undefined) {
          throw new DesktopHelperError("unavailable", "No monitor was found.");
        }
        if (await this.locked()) return { locked: true };
        if (primary.dpmsStatus === false) return { locked: true };
        const regionX = params.regionX === undefined ? primary.x : primary.x + num(params.regionX);
        const regionY = params.regionY === undefined ? primary.y : primary.y + num(params.regionY);
        const regionWidth =
          params.regionWidth === undefined ? primary.width : num(params.regionWidth);
        const regionHeight =
          params.regionHeight === undefined ? primary.height : num(params.regionHeight);
        const maxWidth = Math.max(64, num(params.maxWidth, 1280));
        const maxHeight = Math.max(64, num(params.maxHeight, 1280));
        const scale = Math.min(1, maxWidth / regionWidth, maxHeight / regionHeight);
        const shot = await this.capture.capture({
          x: regionX,
          y: regionY,
          width: regionWidth,
          height: regionHeight,
          outWidth: Math.max(1, Math.round(regionWidth * scale)),
          outHeight: Math.max(1, Math.round(regionHeight * scale)),
          quality: num(params.quality, 80),
        });
        const hash = NodeCryptoHash(shot.data);
        if (typeof params.lastHash === "string" && params.lastHash === hash) {
          return { unchanged: true, hash, captureMs: shot.captureMs, locked: false };
        }
        return {
          data: shot.data,
          width: shot.width,
          height: shot.height,
          hash,
          locked: false,
          captureMs: shot.captureMs,
          screenWidth: primary.width,
          screenHeight: primary.height,
          regionX: regionX - primary.x,
          regionY: regionY - primary.y,
          regionWidth,
          regionHeight,
        };
      }
      case "cursor": {
        const text = await hyprctl(this.session, ["cursorpos"], 5_000);
        const [rawX, rawY] = text.split(",");
        return { x: Number(rawX), y: Number(rawY) };
      }
      case "overlay": {
        if (params.show === false) {
          const id = this.overlayId;
          this.overlayId = null;
          // The session is over: the next one starts a fresh notification.
          this.overlayReplaceId = null;
          this.overlayText = null;
          if (id !== null) await this.closeNotification(id);
          return { shown: false };
        }
        this.overlayCapturable = params.capturable === true;
        await this.showOverlay(str(params.text));
        return { shown: true, id: this.overlayId };
      }
      case "abort":
      case "releaseAll":
        await this.helper.request("releaseall", [], timeoutMs).catch(() => undefined);
        return { released: true };
      case "click": {
        await this.ensureLayout();
        await this.guardInput();
        const point = await this.helperPoint(num(params.x), num(params.y));
        await this.guardPoint({ x: num(params.x), y: num(params.y) });
        const button = str(params.button) || "left";
        const count = Math.max(1, Math.min(3, num(params.count, 1)));
        const modifiers = Array.isArray(params.modifiers)
          ? (params.modifiers as ReadonlyArray<number>)
          : [];
        const held = await this.holdModifiers(modifiers);
        try {
          await sleep(15);
          await this.helper.request(
            "click",
            [button, count, point.x, point.y, point.width, point.height],
            Math.max(timeoutMs, count * 65 + 2_000),
          );
        } finally {
          await this.releaseModifiers(held);
        }
        this.noteBotAction();
        return { done: true };
      }
      case "move": {
        await this.ensureLayout();
        await this.guardInput();
        const point = await this.helperPoint(num(params.x), num(params.y));
        await this.helper.request("move", [point.x, point.y, point.width, point.height], timeoutMs);
        this.noteBotAction();
        return { done: true };
      }
      case "drag": {
        await this.ensureLayout();
        await this.guardInput();
        const from = await this.helperPoint(num(params.fromX), num(params.fromY));
        const to = await this.helperPoint(num(params.toX), num(params.toY));
        await this.guardPoint({ x: num(params.fromX), y: num(params.fromY) });
        await this.guardPoint({ x: num(params.toX), y: num(params.toY) });
        const button = str(params.button) || "left";
        const modifiers = Array.isArray(params.modifiers)
          ? (params.modifiers as ReadonlyArray<number>)
          : [];
        const steps = 18;
        const held = await this.holdModifiers(modifiers);
        try {
          await this.helper.request(
            "drag",
            [from.x, from.y, to.x, to.y, from.width, from.height, button, steps, 200],
            Math.max(timeoutMs, 2_000),
          );
        } finally {
          await this.releaseModifiers(held);
        }
        this.noteBotAction();
        return { done: true, steps };
      }
      case "scroll":
      case "wheel": {
        await this.ensureLayout();
        await this.guardInput();
        if (params.x !== undefined && params.y !== undefined) {
          const point = await this.helperPoint(num(params.x), num(params.y));
          await this.guardPoint({ x: num(params.x), y: num(params.y) });
          await this.helper.request(
            "move",
            [point.x, point.y, point.width, point.height],
            timeoutMs,
          );
        }
        const divisor = cmd === "wheel" ? 120 : 1;
        const dx = num(params.dx) / divisor;
        const dy = num(params.dy) / divisor;
        const modifiers = Array.isArray(params.modifiers)
          ? (params.modifiers as ReadonlyArray<number>)
          : [];
        const held = await this.holdModifiers(modifiers);
        try {
          await this.helper.request("scroll", [dx, dy], timeoutMs);
        } finally {
          await this.releaseModifiers(held);
        }
        this.noteBotAction();
        return { done: true };
      }
      case "type": {
        await this.ensureLayout();
        await this.guardInput();
        const text = str(params.text);
        const segments = text.split("\n");
        const budget = Math.min(55_000, 10_000 + text.length * 20);
        for (const [index, segment] of segments.entries()) {
          if (segment.length > 0) {
            await this.helper.request("type", [segment], budget);
          } else if (index > 0) {
            // An empty line still presses Enter.
          }
          if (index < segments.length - 1) {
            await this.helper.request("key", ["Return", "down"], 5_000);
            await this.helper.request("key", ["Return", "up"], 5_000);
          }
        }
        this.noteBotAction();
        return { done: true, chars: text.length };
      }
      case "keys": {
        await this.ensureLayout();
        await this.guardInput();
        const combos = Array.isArray(params.combos)
          ? (params.combos as ReadonlyArray<ReadonlyArray<KeyEntry>>)
          : [];
        const repeat = Math.max(1, Math.min(50, num(params.repeat, 1)));
        for (let index = 0; index < repeat; index += 1) {
          for (const combo of combos) {
            await this.keyChord(combo);
            await sleep(10);
          }
        }
        this.noteBotAction();
        return { done: true };
      }
      case "button": {
        await this.ensureLayout();
        await this.guardInput();
        if (params.x !== undefined && params.y !== undefined) {
          const point = await this.helperPoint(num(params.x), num(params.y));
          await this.guardPoint({ x: num(params.x), y: num(params.y) });
          await this.helper.request(
            "move",
            [point.x, point.y, point.width, point.height],
            timeoutMs,
          );
        }
        const button = str(params.button) || "left";
        const down = params.down === true;
        await this.helper.request("button", [button, down ? "down" : "up"], timeoutMs);
        this.noteBotAction();
        return { done: true };
      }
      case "hold": {
        await this.ensureLayout();
        await this.guardInput();
        const combo = Array.isArray(params.keys) ? (params.keys as ReadonlyArray<KeyEntry>) : [];
        const durationMs = Math.max(0, num(params.durationMs));
        const repeats = params.repeat !== false;
        const modifiers = combo.filter(isModifierEntry);
        const mains = combo.filter((entry) => !isModifierEntry(entry));
        const down: string[] = [];
        let mainDown: string | null = null;
        try {
          for (const entry of modifiers) {
            const name = keysymName(entry);
            await this.helper.request("key", [name, "down"], 5_000);
            down.push(name);
          }
          const first = mains[0];
          if (first !== undefined) {
            mainDown = keysymName(first);
            await this.helper.request("key", [mainDown, "down"], 5_000);
          }
          if (!repeats && mainDown !== null) {
            // A plain printable hold is one character, never auto-repeat.
            await this.helper.request("key", [mainDown, "up"], 5_000);
            mainDown = null;
          }
          await sleep(durationMs);
        } finally {
          if (mainDown !== null) {
            await this.helper.request("key", [mainDown, "up"], 5_000).catch(() => undefined);
          }
          await this.releaseModifiers(down);
        }
        this.noteBotAction();
        return { done: true, durationMs };
      }
      case "focus":
        // Wayland has no UIAutomation equivalent; the phone keeps its keyboard
        // button and the focus heuristic simply says nothing.
        return { skipped: true };
      case "regions":
        return { rects: [] };
      default:
        throw new DesktopHelperError("invalid", `Unknown desktop command "${cmd}".`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.stopWatch !== null && this.stopFile !== null) {
      NodeFS.unwatchFile(this.stopFile);
      this.stopWatch = null;
    }
    if (this.options.stopChord !== false) {
      void hyprctl(this.session, ["eval", `hl.unbind("${STOP_CHORD}")`], 3_000).catch(
        () => undefined,
      );
    }
    this.events?.destroy();
    this.events = null;
    const id = this.overlayId;
    this.overlayId = null;
    if (id !== null) void this.closeNotification(id);
    void this.helper.dispose();
  }

  /** What the service's status shows for the Desktop bar. */
  async currentWindow(): Promise<{ title: string; class: string } | null> {
    const window = await this.focusedWindow();
    return window === null ? null : { title: window.title, class: window.class };
  }

  /** Test and recovery hook: the parsed session this driver drives. */
  get discoveredSession(): LinuxSession {
    return this.session;
  }
}

function NodeCryptoHash(data: string): string {
  // A short content hash is enough for "the screen did not change".
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Discovers the session and builds the driver; throws a sentence on failure. */
export async function createLinuxDesktopDriver(
  options: LinuxDesktopDriverOptions,
): Promise<LinuxDesktopDriver> {
  const session = await discoverLinuxSession();
  return new LinuxDesktopDriver(session, options);
}
