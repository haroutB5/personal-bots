// @effect-diagnostics nodeBuiltinImport:off - the shortcut fixture writes and removes temp .desktop files.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  browserWindowRefusal,
  classifyBrowserWindow,
  hostOfOrigin,
  isBrowserWindowClass,
  isPwaWindowClass,
  isSharedBrowserCommandLine,
  makeCommandLineCache,
  parseDesktopEntry,
  readInstalledBotsPwaWindowClasses,
  readProcessStartTime,
  sensitiveSitesInTitle,
  userDataDirOf,
  windowTitleNamesSensitiveSite,
  windowTitleShowsBotsApp,
  windowTitleShowsPasswordManager,
  type SensitiveSite,
} from "./browserWindows.ts";

const PROFILE_ROOT = "/home/harout/.personal-bots/dev/personal/browser-profiles";
const SHARED_PROFILE = `${PROFILE_ROOT}/default`;
const USER_BRAVE_PROFILE = "/home/harout/.config/BraveSoftware/Brave-Browser";

const cmd = (...args: ReadonlyArray<string>) => args.join("\0");
const sharedCommandLine = cmd(
  "/opt/brave/brave",
  "--remote-debugging-pipe",
  `--user-data-dir=${SHARED_PROFILE}`,
  "--no-first-run",
);
const userBraveCommandLine = cmd("/opt/brave/brave", `--user-data-dir=${USER_BRAVE_PROFILE}`);
const tempChromiumCommandLine = cmd(
  "/usr/bin/chromium",
  "--user-data-dir=/tmp/chromium-temp-profile-1234",
);

const site = (origin: string, label: string): SensitiveSite => ({ origin, label });

const classify = (input: {
  windowClass?: string;
  title?: string;
  commandLine?: string | null;
  sites?: ReadonlyArray<SensitiveSite> | null;
  botsPwaClasses?: ReadonlyArray<string> | null;
}) =>
  classifyBrowserWindow({
    windowClass: input.windowClass ?? "brave-browser",
    title: input.title ?? "New Tab",
    commandLine: input.commandLine === undefined ? userBraveCommandLine : input.commandLine,
    profileRoots: [PROFILE_ROOT],
    sites: input.sites === undefined ? [] : input.sites,
    botsPwaClasses: input.botsPwaClasses === undefined ? [] : input.botsPwaClasses,
  });

describe("browser window classes", () => {
  it("recognises Brave, Chromium, Chrome, Firefox, Edge and Vivaldi", () => {
    for (const windowClass of [
      "brave-browser",
      "brave-abcdef-Default",
      "chromium",
      "chrome",
      "google-chrome",
      "firefox",
      "microsoft-edge",
      "msedge",
      "vivaldi",
    ]) {
      expect(isBrowserWindowClass(windowClass)).toBe(true);
    }
    expect(isBrowserWindowClass("alacritty")).toBe(false);
    expect(isBrowserWindowClass("org.keepassxc.KeePassXC")).toBe(false);
  });

  it("recognises the browser's installed-PWA class shape", () => {
    expect(isPwaWindowClass("brave-abcdefghijklmnopabcdefghijklmnop-Default")).toBe(true);
    expect(isPwaWindowClass("chrome-abcdefghijklmnopabcdefghijklmnop-Default")).toBe(true);
    expect(isPwaWindowClass("brave-browser")).toBe(false);
    expect(isPwaWindowClass("brave-window-2")).toBe(false);
  });
});

describe("shared browser detection", () => {
  it("reads the user-data-dir from either argument form", () => {
    expect(userDataDirOf(sharedCommandLine)).toBe(SHARED_PROFILE);
    expect(userDataDirOf(cmd("brave", "--user-data-dir", SHARED_PROFILE))).toBe(SHARED_PROFILE);
    expect(userDataDirOf(cmd("brave", "--no-first-run"))).toBe("");
  });

  it("reads a title-collapsed cmdline, as this Brave writes it", () => {
    // Chromium rewrites its process title with spaces; the NULs are gone.
    const collapsed = `/opt/brave-bin/brave --user-data-dir=${SHARED_PROFILE} --no-first-run`;
    expect(userDataDirOf(collapsed)).toBe(SHARED_PROFILE);
    expect(isSharedBrowserCommandLine(collapsed, [PROFILE_ROOT])).toBe(true);
  });

  it("keeps a profile path with a space in one argument", () => {
    const spaced = cmd(
      "/opt/brave/brave",
      `--user-data-dir=${PROFILE_ROOT}/my profile`,
      "--no-first-run",
    );
    expect(userDataDirOf(spaced)).toBe(`${PROFILE_ROOT}/my profile`);
    expect(isSharedBrowserCommandLine(spaced, [])).toBe(true);
  });

  it("needs a path boundary after browser-profiles", () => {
    expect(
      isSharedBrowserCommandLine(
        cmd(
          "/opt/brave/brave",
          "--user-data-dir=/home/harout/.personal-bots/dev/personal/browser-profiles-evil/default",
        ),
        [],
      ),
    ).toBe(false);
    expect(
      isSharedBrowserCommandLine(
        cmd(
          "/opt/brave/brave",
          "--user-data-dir=/home/harout/.personal-bots/dev/personal/browser-profiles/default",
        ),
        [],
      ),
    ).toBe(true);
  });

  it("blocks the profile hbots launched and nothing else", () => {
    expect(isSharedBrowserCommandLine(sharedCommandLine, [PROFILE_ROOT])).toBe(true);
    // Another data root still follows the convention.
    expect(
      isSharedBrowserCommandLine(
        cmd(
          "brave",
          "--user-data-dir=/home/harout/.personal-bots/prod/personal/browser-profiles/default",
        ),
        [],
      ),
    ).toBe(true);
    expect(isSharedBrowserCommandLine(userBraveCommandLine, [PROFILE_ROOT])).toBe(false);
    expect(isSharedBrowserCommandLine(tempChromiumCommandLine, [PROFILE_ROOT])).toBe(false);
  });
});

describe("sensitive site matching", () => {
  it("reads the host of an origin without www", () => {
    expect(hostOfOrigin("https://www.bank.example/login")).toBe("bank.example");
    expect(hostOfOrigin("not a url")).toBe("");
  });

  it("matches the host and the label against the title, case-insensitively", () => {
    expect(
      windowTitleNamesSensitiveSite("Online banking - Brave", [site("https://bank.example", "")]),
    ).toBe(false);
    expect(
      windowTitleNamesSensitiveSite("bank.example - Brave", [site("https://bank.example", "")]),
    ).toBe(true);
    expect(
      windowTitleNamesSensitiveSite("BARCLAYS ONLINE - Brave", [
        site("https://bank.example", "barclays"),
      ]),
    ).toBe(true);
    expect(
      windowTitleNamesSensitiveSite("YouTube Music - Brave", [
        site("https://bank.example", "barclays"),
      ]),
    ).toBe(false);
  });

  it("ignores labels too short to mean anything", () => {
    expect(
      windowTitleNamesSensitiveSite("Everything - Brave", [site("https://x.example", "e")]),
    ).toBe(false);
  });

  it("matches a label only on a word boundary", () => {
    expect(
      windowTitleNamesSensitiveSite("Barclays Online - Brave", [
        site("https://bank.example", "barclays"),
      ]),
    ).toBe(true);
    // The old containment check blocked this page for no reason.
    expect(
      windowTitleNamesSensitiveSite("Barclaysian history - Brave", [
        site("https://bank.example", "barclays"),
      ]),
    ).toBe(false);
  });

  it("names the origins a capture carries", () => {
    expect(
      sensitiveSitesInTitle("Barclays Online - Brave", [
        site("https://bank.example", "Barclays"),
        site("https://mail.example", "Mail"),
      ]),
    ).toEqual(["https://bank.example"]);
    expect(
      sensitiveSitesInTitle("YouTube Music - Brave", [site("https://bank.example", "x")]),
    ).toEqual([]);
  });
});

describe("password manager titles", () => {
  it("recognises the password managers and their password pages", () => {
    for (const title of [
      "Passwords - Brave",
      "Password manager - Firefox",
      "1Password",
      "Bitwarden",
      "KeePassXC",
      "Proton Pass",
      "Enpass",
      "chrome://password-manager/passwords",
      "brave://password-manager/passwords",
    ]) {
      expect(windowTitleShowsPasswordManager(title)).toBe(true);
    }
    expect(windowTitleShowsPasswordManager("YouTube Music - Brave")).toBe(false);
  });
});

describe("Bots app detection", () => {
  it("recognises every document title apps/web can set", () => {
    for (const title of [
      "T3 Code",
      "T3 Code - Brave",
      "T3 Code (Alpha) - Brave",
      "T3 Code (Dev) - Chromium",
      "T3 Code (Nightly) - Brave",
      "Backend · T3 Code (Alpha)",
      "Bots",
      "Bots (Alpha)",
    ]) {
      expect(windowTitleShowsBotsApp(title)).toBe(true);
    }
  });

  it("does not take other pages for the app", () => {
    expect(windowTitleShowsBotsApp("Bots and AI - Brave")).toBe(false);
    expect(windowTitleShowsBotsApp("YouTube Music - Brave")).toBe(false);
    expect(windowTitleShowsBotsApp("")).toBe(false);
  });

  it("reads the name, class and app id out of a .desktop entry", () => {
    const entry = parseDesktopEntry(
      [
        "[Desktop Entry]",
        "Name=Bots",
        "Exec=/usr/bin/brave-browser --profile-directory=Default --app-id=abcdefghijklmnopabcdefghijklmnop",
        "StartupWMClass=brave-abcdefghijklmnopabcdefghijklmnop-Default",
        "",
        "[Desktop Action new-window]",
        "Name=New Window",
      ].join("\n"),
    );
    expect(entry.name).toBe("bots");
    expect(entry.appId).toBe("abcdefghijklmnopabcdefghijklmnop");
    expect(entry.windowClass).toBe("brave-abcdefghijklmnopabcdefghijklmnop-Default");
  });
});

describe("classifyBrowserWindow", () => {
  it("blocks a normal tab titled the way the app titles it", () => {
    for (const title of [
      "T3 Code (Alpha) - Brave",
      "T3 Code - Brave",
      "T3 Code (Nightly) - Brave",
    ]) {
      expect(classify({ title })).toEqual({ kind: "bots-app" });
    }
  });

  it("blocks the installed Bots PWA by its window class", () => {
    const botsPwa = "brave-abcdefghijklmnopabcdefghijklmnop-Default";
    expect(classify({ windowClass: botsPwa, title: "Home", botsPwaClasses: [botsPwa] })).toEqual({
      kind: "bots-app",
    });
    // The same shape without the installed class is another app's PWA.
    expect(classify({ windowClass: botsPwa, title: "Home", botsPwaClasses: [] })).toEqual({
      kind: "allow",
    });
  });

  it("still allows another Brave PWA", () => {
    expect(
      classify({
        windowClass: "brave-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-Default",
        title: "Calendar",
        botsPwaClasses: ["brave-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-Default"],
      }),
    ).toEqual({ kind: "allow" });
  });

  it("fails closed on an untitled PWA when installed apps cannot be read", () => {
    const pwa = "brave-abcdefghijklmnopabcdefghijklmnop-Default";
    expect(classify({ windowClass: pwa, title: "", botsPwaClasses: null })).toEqual({
      kind: "bots-app",
    });
    // A title that is not the app is enough to clear another PWA.
    expect(classify({ windowClass: pwa, title: "Calendar", botsPwaClasses: null })).toEqual({
      kind: "allow",
    });
  });

  it("blocks the bots' shared browser by its pid, not its class", () => {
    expect(classify({ windowClass: "brave-browser", commandLine: sharedCommandLine })).toEqual({
      kind: "shared",
    });
    // A PWA window of the same process is the shared browser too.
    expect(
      classify({ windowClass: "brave-abcdef-Default", commandLine: sharedCommandLine }),
    ).toEqual({ kind: "shared" });
  });

  it("allows the user's own brave-browser window", () => {
    expect(classify({ windowClass: "brave-browser", title: "YouTube Music - Brave" })).toEqual({
      kind: "allow",
    });
  });

  it("allows a Chromium window with a temporary profile", () => {
    expect(
      classify({
        windowClass: "chromium",
        title: "New Tab - Chromium",
        commandLine: tempChromiumCommandLine,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("allows a Brave PWA", () => {
    expect(
      classify({
        windowClass: "brave-abcdef-Default",
        title: "Calendar",
        commandLine: userBraveCommandLine,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("blocks a window titled as a password manager", () => {
    expect(classify({ title: "Passwords - Brave" })).toEqual({ kind: "password-manager" });
    expect(classify({ title: "1Password - Firefox", windowClass: "firefox" })).toEqual({
      kind: "password-manager",
    });
  });

  it("blocks a window whose title names a sensitive site", () => {
    expect(
      classify({
        windowClass: "brave-browser",
        title: "Barclays Online - Brave",
        sites: [site("https://bank.example", "Barclays")],
      }),
    ).toEqual({ kind: "sensitive" });
  });

  it("blocks every browser window when the sensitive list cannot be read", () => {
    expect(classify({ sites: null })).toEqual({ kind: "list-unreadable" });
    // But never a non-browser window: a broken list must not stop typing.
    expect(classify({ windowClass: "alacritty", sites: null })).toEqual({ kind: "allow" });
  });

  it("blocks a browser window whose process cannot be read", () => {
    expect(classify({ commandLine: null })).toEqual({ kind: "unidentified" });
  });
});

describe("readInstalledBotsPwaWindowClasses", () => {
  const shortcutsDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bots-pwa-"));

  it("finds the Bots PWA and ignores another app's shortcut", () => {
    const dir = shortcutsDir();
    try {
      NodeFS.writeFileSync(
        NodePath.join(dir, "brave-abcdefghijklmnopabcdefghijklmnop-Default.desktop"),
        [
          "[Desktop Entry]",
          "Name=Bots",
          "Exec=/usr/bin/brave-browser --app-id=abcdefghijklmnopabcdefghijklmnop",
          "StartupWMClass=brave-abcdefghijklmnopabcdefghijklmnop-Default",
        ].join("\n"),
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "brave-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-Default.desktop"),
        [
          "[Desktop Entry]",
          "Name=YouTube",
          "Exec=/usr/bin/brave-browser --app-id=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "StartupWMClass=brave-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-Default",
        ].join("\n"),
      );
      expect(readInstalledBotsPwaWindowClasses([dir])).toEqual([
        "brave-abcdefghijklmnopabcdefghijklmnop-default",
      ]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives the class from --app-id when StartupWMClass is missing", () => {
    const dir = shortcutsDir();
    try {
      NodeFS.writeFileSync(
        NodePath.join(dir, "chrome-cccccccccccccccccccccccccccccccc-Default.desktop"),
        [
          "[Desktop Entry]",
          "Name=T3 Code (Alpha)",
          "Exec=/usr/bin/google-chrome --app-id=cccccccccccccccccccccccccccccccc",
        ].join("\n"),
      );
      expect(readInstalledBotsPwaWindowClasses([dir])).toEqual([
        "chrome-cccccccccccccccccccccccccccccccc-default",
      ]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a missing folder as no PWA and an unreadable path as unknown", () => {
    expect(
      readInstalledBotsPwaWindowClasses([
        NodePath.join(NodeOS.tmpdir(), `missing-apps-${process.pid}`),
      ]),
    ).toEqual([]);
    const notADir = NodePath.join(NodeOS.tmpdir(), `not-a-dir-${process.pid}`);
    NodeFS.writeFileSync(notADir, "x");
    try {
      expect(readInstalledBotsPwaWindowClasses([notADir])).toBeNull();
    } finally {
      NodeFS.unlinkSync(notADir);
    }
  });
});

describe("browserWindowRefusal", () => {
  it("says what was blocked and why, for focus and for a point", () => {
    expect(browserWindowRefusal("shared", false)).toContain("bots' shared browser");
    expect(browserWindowRefusal("shared", false)).toContain("browser tools");
    expect(browserWindowRefusal("bots-app", false)).toBe(
      "This window is the Bots app; bots can't drive it from the desktop.",
    );
    expect(browserWindowRefusal("bots-app", true)).toBe(
      "This window is the Bots app; bots can't drive it from the desktop.",
    );
    expect(browserWindowRefusal("sensitive", false)).toContain("marked sensitive");
    expect(browserWindowRefusal("sensitive", true)).toContain("under that point");
    expect(browserWindowRefusal("list-unreadable", false)).toContain("could not be checked");
    expect(browserWindowRefusal("unidentified", true)).toContain("could not be identified");
    expect(browserWindowRefusal("allow", false)).toBe("");
  });
});

describe("makeCommandLineCache", () => {
  it("reads each pid once while its start time is the same", () => {
    let reads = 0;
    const cache = makeCommandLineCache(
      (pid) => {
        reads += 1;
        return pid === 7 ? userBraveCommandLine : null;
      },
      undefined,
      (pid) => `start-${pid}`,
    );
    expect(cache(7)).toBe(userBraveCommandLine);
    expect(cache(7)).toBe(userBraveCommandLine);
    expect(reads).toBe(1);
    expect(cache(8)).toBeNull();
    expect(cache(8)).toBeNull();
    expect(reads).toBe(2);
  });

  it("does not hand a reused pid the previous process's profile", () => {
    let start = "100";
    let reads = 0;
    const cache = makeCommandLineCache(
      () => {
        reads += 1;
        return start === "100" ? userBraveCommandLine : sharedCommandLine;
      },
      undefined,
      () => start,
    );
    expect(cache(7)).toBe(userBraveCommandLine);
    expect(cache(7)).toBe(userBraveCommandLine);
    expect(reads).toBe(1);
    // The kernel reused pid 7 for another process: its start time changed.
    start = "200";
    expect(cache(7)).toBe(sharedCommandLine);
    expect(reads).toBe(2);
  });

  it("reads the real start time, and reports a gone process as unknown", () => {
    expect(readProcessStartTime(process.pid)).toMatch(/^\d+$/);
    expect(readProcessStartTime(999_999_999)).toBeNull();
    const cache = makeCommandLineCache(
      () => {
        throw new Error("must not read a dead pid");
      },
      undefined,
      () => null,
    );
    expect(cache(7)).toBeNull();
  });
});
