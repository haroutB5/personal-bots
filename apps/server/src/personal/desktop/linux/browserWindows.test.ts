import { describe, expect, it } from "@effect/vitest";

import {
  browserWindowRefusal,
  classifyBrowserWindow,
  hostOfOrigin,
  isBrowserWindowClass,
  isSharedBrowserCommandLine,
  makeCommandLineCache,
  userDataDirOf,
  windowTitleNamesSensitiveSite,
  type SensitiveSite,
} from "./browserWindows.ts";

const PROFILE_ROOT = "/home/harout/.personal-bots/dev/personal/browser-profiles";
const SHARED_PROFILE = `${PROFILE_ROOT}/default`;
const USER_BRAVE_PROFILE = "/home/harout/.config/BraveSoftware/Brave-Browser";

const sharedCommandLine = `/opt/brave/brave --remote-debugging-pipe --user-data-dir=${SHARED_PROFILE} --no-first-run`;
const userBraveCommandLine = `/opt/brave/brave --user-data-dir=${USER_BRAVE_PROFILE}`;
const tempChromiumCommandLine = "/usr/bin/chromium --user-data-dir=/tmp/chromium-temp-profile-1234";

const site = (origin: string, label: string): SensitiveSite => ({ origin, label });

const classify = (input: {
  windowClass?: string;
  title?: string;
  commandLine?: string | null;
  sites?: ReadonlyArray<SensitiveSite> | null;
}) =>
  classifyBrowserWindow({
    windowClass: input.windowClass ?? "brave-browser",
    title: input.title ?? "New Tab",
    commandLine: input.commandLine === undefined ? userBraveCommandLine : input.commandLine,
    profileRoots: [PROFILE_ROOT],
    sites: input.sites === undefined ? [] : input.sites,
  });

describe("browser window classes", () => {
  it("recognises Brave, Chromium and Chrome, including Brave PWAs", () => {
    for (const windowClass of [
      "brave-browser",
      "brave-abcdef-Default",
      "chromium",
      "chrome",
      "google-chrome",
    ]) {
      expect(isBrowserWindowClass(windowClass)).toBe(true);
    }
    expect(isBrowserWindowClass("alacritty")).toBe(false);
    expect(isBrowserWindowClass("org.keepassxc.KeePassXC")).toBe(false);
  });
});

describe("shared browser detection", () => {
  it("reads the user-data-dir from either argument form", () => {
    expect(userDataDirOf(sharedCommandLine)).toBe(SHARED_PROFILE);
    expect(userDataDirOf(`brave --user-data-dir ${SHARED_PROFILE}`)).toBe(SHARED_PROFILE);
    expect(userDataDirOf("brave --no-first-run")).toBe("");
  });

  it("blocks the profile hbots launched and nothing else", () => {
    expect(isSharedBrowserCommandLine(sharedCommandLine, [PROFILE_ROOT])).toBe(true);
    // Another data root still follows the convention.
    expect(
      isSharedBrowserCommandLine(
        "brave --user-data-dir=/home/harout/.personal-bots/prod/personal/browser-profiles/default",
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
});

describe("classifyBrowserWindow", () => {
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

describe("browserWindowRefusal", () => {
  it("says what was blocked and why, for focus and for a point", () => {
    expect(browserWindowRefusal("shared", false)).toContain("bots' shared browser");
    expect(browserWindowRefusal("shared", false)).toContain("browser tools");
    expect(browserWindowRefusal("sensitive", false)).toContain("marked sensitive");
    expect(browserWindowRefusal("sensitive", true)).toContain("under that point");
    expect(browserWindowRefusal("list-unreadable", false)).toContain("could not be checked");
    expect(browserWindowRefusal("unidentified", true)).toContain("could not be identified");
    expect(browserWindowRefusal("allow", false)).toBe("");
  });
});

describe("makeCommandLineCache", () => {
  it("reads each pid once, and a miss only briefly", () => {
    let reads = 0;
    const cache = makeCommandLineCache((pid) => {
      reads += 1;
      return pid === 7 ? userBraveCommandLine : null;
    });
    expect(cache(7)).toBe(userBraveCommandLine);
    expect(cache(7)).toBe(userBraveCommandLine);
    expect(reads).toBe(1);
    expect(cache(8)).toBeNull();
    expect(cache(8)).toBeNull();
    expect(reads).toBe(2);
  });
});
