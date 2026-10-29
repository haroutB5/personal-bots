// @effect-diagnostics nodeBuiltinImport:off - /proc is how this platform names a window's process.
// @effect-diagnostics globalDate:off - the per-pid cache uses a plain millisecond clock.
/**
 * Which windows the desktop tools may drive.
 *
 * The shared browser is hbots' own Brave: it has a lease and a sensitive-site
 * pause the desktop would bypass, so a window of that process stays closed to
 * clicks and keys. Every other browser window is the user's, including Brave
 * PWAs (`brave-<app>-Default`), and may be driven — unless its title names one
 * of the sites they marked sensitive, or it shows the Bots app itself. The
 * Bots UI can approve its own browser-help card, undo memory, change settings
 * and edit bots, so a bot clicking there would bypass every approval. That
 * check is class-independent: the app's title closes an Electron or Firefox
 * window too.
 *
 * The sensitive list is the one the browser already uses: the origins and
 * labels of saved logins with the sensitive flag. A list that cannot be read
 * blocks browser windows, the pre-guard behaviour. Password managers are
 * refused by class and by title: opening one is how a screenshot would hand
 * the bot every saved password.
 */
import {
  PERSONAL_APP_BASE_NAME,
  PERSONAL_APP_MANIFEST_NAME,
  personalAppDisplayTitles,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** A saved login the user marked sensitive: its origin hosts a sensitive site. */
export interface SensitiveSite {
  readonly origin: string;
  readonly label: string;
}

export type BrowserWindowVerdict =
  | { readonly kind: "allow" }
  /** hbots' own Brave, identified by its profile, never by its window class. */
  | { readonly kind: "shared" }
  /** The Bots app itself: its web UI can approve cards and change settings. */
  | { readonly kind: "bots-app" }
  /** A password manager, by title or PWA class. */
  | { readonly kind: "password-manager" }
  /** The window's title names a site the user marked sensitive. */
  | { readonly kind: "sensitive" }
  /** The process could not be read, so it cannot be told apart from the shared one. */
  | { readonly kind: "unidentified" }
  /** The sensitive list was unavailable, so no browser window can be cleared. */
  | { readonly kind: "list-unreadable" };

/**
 * Matched by prefix. Firefox, Edge and Vivaldi have no shared browser of ours,
 * but they do show sensitive sites and password managers, so they take the
 * same title rules.
 */
const BROWSER_CLASS_PREFIXES = [
  "brave",
  "chromium",
  "chrome",
  "google-chrome",
  "firefox",
  "microsoft-edge",
  "msedge",
  "vivaldi",
];

export const isBrowserWindowClass = (windowClass: string): boolean =>
  BROWSER_CLASS_PREFIXES.some((prefix) => windowClass.toLowerCase().startsWith(prefix));

/** hbots' browser profiles: `<baseDir>/personal/browser-profiles/<name>`. */
const SHARED_PROFILE_SEGMENT = `${NodePath.sep}personal${NodePath.sep}browser-profiles`;

/** Resolve symlinks when the path exists; a missing profile is compared by name. */
const realPath = (path: string): string => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

/** True when `path` is `base` itself or sits under it, on a path boundary. */
const underPath = (path: string, base: string): boolean => {
  const root = base.replace(/\/+$/, "");
  return path === root || path.startsWith(`${root}${NodePath.sep}`);
};

/** True when `path` is a browser-profiles folder, or sits under one. */
const underSharedProfiles = (path: string): boolean =>
  path.endsWith(SHARED_PROFILE_SEGMENT) ||
  path.includes(`${SHARED_PROFILE_SEGMENT}${NodePath.sep}`);

/**
 * The arguments of a `/proc/<pid>/cmdline`. Linux separates them with NULs,
 * but Chromium and Brave rewrite their process title, which this build does
 * with spaces: the whole line collapses into one argv entry. NUL-separated
 * input keeps a profile path with spaces in one piece; only a collapsed line
 * falls back to whitespace.
 */
export function commandLineArgs(commandLine: string): ReadonlyArray<string> {
  const byNul = commandLine.split("\0").filter((arg) => arg.length > 0);
  if (byNul.length > 1) return byNul;
  const collapsed = byNul[0] ?? "";
  return collapsed.length === 0 ? [] : collapsed.split(/\s+/).filter((arg) => arg.length > 0);
}

/** The `--user-data-dir` value a Chromium process was started with, if any. */
export function userDataDirOf(commandLine: string): string {
  const args = commandLineArgs(commandLine);
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith("--user-data-dir=")) {
      return arg.slice("--user-data-dir=".length).replace(/^["']|["']$/g, "");
    }
    if (arg === "--user-data-dir") {
      return (args[index + 1] ?? "").replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

/**
 * True when the process is one hbots launched: its profile sits under a
 * configured browser-profiles root (or the convention's path, so a server in
 * another data root is still recognised). A user's own Brave profile does not.
 * Both sides are real paths, so a symlinked profile cannot pass itself off as
 * the user's.
 */
export function isSharedBrowserCommandLine(
  commandLine: string,
  profileRoots: ReadonlyArray<string>,
): boolean {
  const dir = userDataDirOf(commandLine);
  if (dir.length === 0) return false;
  const resolved = realPath(dir);
  const underRoot = profileRoots.some((root) => underPath(resolved, realPath(root)));
  return underRoot || underSharedProfiles(resolved);
}

/** The hostname of a saved login's origin, without a leading `www.`. */
export function hostOfOrigin(origin: string): string {
  const trimmed = origin.trim();
  if (trimmed.length === 0) return "";
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The term on a word boundary: "barclays" matches "Barclays Online", not "barclaysian". */
const containsWord = (haystack: string, term: string): boolean =>
  new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:$|[^a-z0-9])`, "i").test(haystack);

/**
 * Which of the user's sensitive sites a window title names. Case insensitive,
 * on the host and on the site's label, on word boundaries so a short label
 * does not match inside another word. Over-blocking is the safe side of a
 * miss. The returned values are the origins, the exposure store's unit.
 */
export function sensitiveSitesInTitle(
  title: string,
  sites: ReadonlyArray<SensitiveSite>,
): ReadonlyArray<string> {
  const haystack = title.trim().toLowerCase();
  if (haystack.length === 0) return [];
  const matched = new Set<string>();
  for (const site of sites) {
    const host = hostOfOrigin(site.origin);
    const label = site.label.trim().toLowerCase();
    const named =
      (host.length >= 3 && containsWord(haystack, host)) ||
      (label.length >= 3 && containsWord(haystack, label));
    if (!named) continue;
    const source = site.origin.trim();
    matched.add(source.length > 0 ? source : site.label.trim());
  }
  return [...matched];
}

/** Whether a window title names one of the user's sensitive sites. */
export function windowTitleNamesSensitiveSite(
  title: string,
  sites: ReadonlyArray<SensitiveSite>,
): boolean {
  return sensitiveSitesInTitle(title, sites).length > 0;
}

/**
 * Whether a window title is the Bots app's own. `apps/web` sets one app-wide
 * title from `branding.ts`, whose default comes from the contracts (the
 * latest channel is the bare "T3 Code", this build "T3 Code (Alpha)"), and no
 * route or chat changes it. A browser appends " - Brave", so compare by
 * containment; over-blocking a page about T3 Code is the safe side of a miss.
 * The web manifest calls the app "Bots", which a PWA can show before the page
 * loads.
 */
export function windowTitleShowsBotsApp(title: string): boolean {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.length === 0) return false;
  if (normalized.includes(PERSONAL_APP_BASE_NAME.toLowerCase())) return true;
  const manifest = PERSONAL_APP_MANIFEST_NAME.toLowerCase();
  return (
    normalized === manifest ||
    normalized.startsWith(`${manifest} (`) ||
    normalized.startsWith(`${manifest} - `)
  );
}

/** Words a browser title uses when it shows saved passwords. */
const PASSWORD_MANAGER_TITLE_TERMS = [
  "password manager",
  "passwords",
  "1password",
  "bitwarden",
  "keepass",
  "proton pass",
  "enpass",
  "chrome://password-manager",
  "brave://password-manager",
  "edge://settings/passwords",
];

/** Whether a browser title says it is a password manager or its password list. */
export function windowTitleShowsPasswordManager(title: string): boolean {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    normalized.length > 0 && PASSWORD_MANAGER_TITLE_TERMS.some((term) => normalized.includes(term))
  );
}

/** Chromium's class for an installed web app: `<browser>-<appid>-Default`. */
export function isPwaWindowClass(windowClass: string): boolean {
  return /^(?:brave|chromium|chrome|google-chrome)-[a-z0-9]+-default$/i.test(windowClass.trim());
}

/** Names a shortcut for the Bots app may carry: the manifest name, then the title. */
const BOTS_APP_SHORTCUT_NAMES = new Set([
  PERSONAL_APP_MANIFEST_NAME.toLowerCase(),
  ...personalAppDisplayTitles().map((title) => title.toLowerCase()),
]);

interface DesktopEntry {
  /** Lower-cased `Name`, used to recognise the app's shortcut. */
  readonly name: string;
  readonly windowClass: string;
  readonly appId: string;
}

/** The fields of a `.desktop` file this guard reads. */
export function parseDesktopEntry(content: string): DesktopEntry {
  let name = "";
  let windowClass = "";
  let appId = "";
  let inMainSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inMainSection = line === "[Desktop Entry]";
      continue;
    }
    if (!inMainSection || line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Name" && name.length === 0) name = value.toLowerCase();
    else if (key === "StartupWMClass" && windowClass.length === 0) windowClass = value;
    else if (key === "Exec" && appId.length === 0) {
      appId = /--app-id=([A-Za-z0-9]+)/.exec(value)?.[1] ?? "";
    }
  }
  return { name, windowClass, appId };
}

/** Where the desktop environment keeps installed application shortcuts. */
export function defaultApplicationDirs(): ReadonlyArray<string> {
  const xdgDataHome = (process.env.XDG_DATA_HOME ?? "").trim();
  const homeApplications = NodePath.join(NodeOS.homedir(), ".local", "share", "applications");
  if (xdgDataHome.length === 0) return [homeApplications];
  const xdgApplications = NodePath.join(xdgDataHome, "applications");
  return xdgApplications === homeApplications
    ? [homeApplications]
    : [xdgApplications, homeApplications];
}

/** `brave-<id>-Default` from a shortcut named `brave-<id>-Default.desktop`. */
function pwaWindowClassFromShortcut(shortcutName: string, appId: string): string {
  const browser = /^(brave|chrome|chromium)-/.exec(shortcutName)?.[1];
  return browser !== undefined && appId.length > 0 ? `${browser}-${appId}-Default` : "";
}

/**
 * The window classes of the installed Bots PWA, read from its `.desktop`
 * shortcut (`StartupWMClass`, or the `--app-id` in `Exec`). No Bots PWA is
 * installed on this machine today, so the list is empty; installing one adds
 * its class without a code change. Null when a shortcut cannot be read: the
 * caller then falls back to the title and fails closed on an untitled PWA.
 */
export function readInstalledBotsPwaWindowClasses(
  applicationsDirs: ReadonlyArray<string> = defaultApplicationDirs(),
): ReadonlyArray<string> | null {
  const classes = new Set<string>();
  for (const dir of applicationsDirs) {
    let entries: ReadonlyArray<string>;
    try {
      entries = NodeFS.readdirSync(dir);
    } catch (error) {
      // No applications folder means no installed PWA, not an unknown one.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".desktop")) continue;
      let content: string;
      try {
        content = NodeFS.readFileSync(NodePath.join(dir, entry), "utf8");
      } catch {
        return null;
      }
      const parsed = parseDesktopEntry(content);
      if (!BOTS_APP_SHORTCUT_NAMES.has(parsed.name)) continue;
      const windowClass =
        parsed.windowClass.length > 0
          ? parsed.windowClass
          : pwaWindowClassFromShortcut(entry, parsed.appId);
      if (windowClass.length > 0) classes.add(windowClass.trim().toLowerCase());
    }
  }
  return [...classes];
}

/**
 * The one decision the browser guards share. `sites` is null when the list
 * could not be read; `commandLine` is null when the window's pid could not be
 * read; `botsPwaClasses` is null when the installed shortcuts could not be
 * read.
 */
export function classifyBrowserWindow(input: {
  readonly windowClass: string;
  readonly title: string;
  readonly commandLine: string | null;
  readonly profileRoots: ReadonlyArray<string>;
  readonly sites: ReadonlyArray<SensitiveSite> | null;
  readonly botsPwaClasses: ReadonlyArray<string> | null;
}): BrowserWindowVerdict {
  if (!isBrowserWindowClass(input.windowClass)) return { kind: "allow" };
  if (input.commandLine === null) return { kind: "unidentified" };
  if (isSharedBrowserCommandLine(input.commandLine, input.profileRoots)) {
    return { kind: "shared" };
  }
  if (windowTitleShowsBotsApp(input.title)) return { kind: "bots-app" };
  if (windowTitleShowsPasswordManager(input.title)) return { kind: "password-manager" };
  const windowClass = input.windowClass.trim().toLowerCase();
  if (input.botsPwaClasses !== null) {
    if (input.botsPwaClasses.some((known) => known.trim().toLowerCase() === windowClass)) {
      return { kind: "bots-app" };
    }
  } else if (isPwaWindowClass(input.windowClass) && input.title.trim().length === 0) {
    // The shortcut list could not be read and this PWA has no title to check:
    // it could be the Bots app still loading, so fail closed.
    return { kind: "bots-app" };
  }
  if (input.sites === null) return { kind: "list-unreadable" };
  if (windowTitleNamesSensitiveSite(input.title, input.sites)) return { kind: "sensitive" };
  return { kind: "allow" };
}

/** What the bot is told when a browser window is refused. */
export function browserWindowRefusal(kind: BrowserWindowVerdict["kind"], atPoint: boolean): string {
  switch (kind) {
    case "shared":
      return atPoint
        ? "The bots' shared browser is under that point; use the browser tools so the lease and the sensitive-site pause apply. The desktop cannot click it."
        : "This is the bots' shared browser; use the browser tools so the lease and the sensitive-site pause apply. The desktop cannot drive it.";
    case "bots-app":
      return "This window is the Bots app; bots can't drive it from the desktop.";
    case "password-manager":
      return atPoint
        ? "A password manager window is under that point. The desktop tools never type or click in one; ask the user to do it."
        : "That window is a password manager. The desktop tools never type or click in one; ask the user to do it.";
    case "sensitive":
      return atPoint
        ? "This browser window shows a site you marked sensitive and is under that point, so nothing was clicked. Ask the user to do it."
        : "This browser window shows a site you marked sensitive, so the desktop tools will not click or type in it. Ask the user to do it.";
    case "unidentified":
      return atPoint
        ? "The browser process under that point could not be identified, so nothing was clicked. Ask the user to do it in that window."
        : "The browser process behind this window could not be identified, so nothing was clicked or typed. Ask the user to do it in that window.";
    case "list-unreadable":
      return atPoint
        ? "The browser window under that point could not be checked against the sites you marked sensitive, so nothing was clicked."
        : "This browser window could not be checked against the sites you marked sensitive, so nothing was clicked or typed.";
    case "allow":
      return "";
  }
}

/** `/proc/<pid>/cmdline`, NUL-separated args kept apart so paths stay exact. */
export function readProcessCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

/**
 * Field 22 of `/proc/<pid>/stat`: the start time in clock ticks. A pid is
 * reused by the kernel, the start time is not, so caching a command line by
 * both cannot attribute one browser's profile to its successor. The comm
 * field may contain spaces and parentheses, so fields are counted after the
 * last `)`.
 */
export function readProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const start = fields[19];
    return start === undefined || start.length === 0 ? null : start;
  } catch {
    return null;
  }
}

/**
 * Wraps a command-line reader with a cache keyed by pid **and** the process's
 * start time, so a reused pid never inherits the previous browser's profile.
 * The focus and point guards run on every action; `/proc` is cheap but not
 * free, and the cache also spares repeated reads within one action.
 */
export function makeCommandLineCache(
  read: (pid: number) => string | null = readProcessCommandLine,
  ttlMs = 30_000,
  readStartTime: (pid: number) => string | null = readProcessStartTime,
): (pid: number) => string | null {
  const cache = new Map<string, { readonly commandLine: string | null; readonly at: number }>();
  return (pid) => {
    const start = readStartTime(pid);
    // No start time means the process is gone, or `/proc` is not answering:
    // either way this window cannot be told apart from the shared one.
    if (start === null) return null;
    const key = `${pid}:${start}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit !== undefined && now - hit.at < (hit.commandLine === null ? 5_000 : ttlMs)) {
      return hit.commandLine;
    }
    const commandLine = read(pid);
    if (cache.size >= 256) {
      for (const [entryKey, entry] of cache) {
        if (now - entry.at >= ttlMs) cache.delete(entryKey);
      }
      if (cache.size >= 256) cache.clear();
    }
    cache.set(key, { commandLine, at: now });
    return commandLine;
  };
}
