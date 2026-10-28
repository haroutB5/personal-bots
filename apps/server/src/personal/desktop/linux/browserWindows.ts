// @effect-diagnostics nodeBuiltinImport:off - /proc is how this platform names a window's process.
// @effect-diagnostics globalDate:off - the per-pid cache uses a plain millisecond clock.
/**
 * Which brave/Chromium/Chrome windows the desktop tools may drive.
 *
 * The shared browser is hbots' own Brave: it has a lease and a sensitive-site
 * pause the desktop would bypass, so a window of that process stays closed to
 * clicks and keys. Every other browser window is the user's, including Brave
 * PWAs (`brave-<app>-Default`), and may be driven — unless its title names one
 * of the sites they marked sensitive, because that is the same data the
 * browser tools must not carry out of the shared browser.
 *
 * The sensitive list is the one the browser already uses: the origins and
 * labels of saved logins with the sensitive flag. A list that cannot be read
 * blocks browser windows, the pre-guard behaviour.
 */
import * as NodeFS from "node:fs";
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
  /** The window's title names a site the user marked sensitive. */
  | { readonly kind: "sensitive" }
  /** The process could not be read, so it cannot be told apart from the shared one. */
  | { readonly kind: "unidentified" }
  /** The sensitive list was unavailable, so no browser window can be cleared. */
  | { readonly kind: "list-unreadable" };

/** Matched by prefix: a Brave PWA is `brave-<app>-Default`. */
const BROWSER_CLASS_PREFIXES = ["brave", "chromium", "chrome", "google-chrome"];

export const isBrowserWindowClass = (windowClass: string): boolean =>
  BROWSER_CLASS_PREFIXES.some((prefix) => windowClass.toLowerCase().startsWith(prefix));

/** hbots' browser profiles: `<baseDir>/personal/browser-profiles/<name>`. */
const SHARED_PROFILE_SEGMENT = `${NodePath.sep}personal${NodePath.sep}browser-profiles`;

/** The `--user-data-dir` value a Chromium process was started with, if any. */
export function userDataDirOf(commandLine: string): string {
  const args = commandLine.split(/[\0\s]+/).filter((arg) => arg.length > 0);
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
 */
export function isSharedBrowserCommandLine(
  commandLine: string,
  profileRoots: ReadonlyArray<string>,
): boolean {
  const dir = userDataDirOf(commandLine);
  if (dir.length === 0) return false;
  const resolved = NodePath.resolve(dir);
  const underRoot = profileRoots.some((root) => {
    const base = NodePath.resolve(root).replace(/\/+$/, "");
    return resolved === base || resolved.startsWith(`${base}${NodePath.sep}`);
  });
  return underRoot || resolved.includes(SHARED_PROFILE_SEGMENT);
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

/**
 * Whether a window title names one of the user's sensitive sites. Case
 * insensitive, on the host and on the site's label. Labels shorter than three
 * characters are ignored: one letter would match most titles and block the
 * whole of the user's browsing. Over-blocking is the safe side of a miss, so a
 * plain containment check is enough.
 */
export function windowTitleNamesSensitiveSite(
  title: string,
  sites: ReadonlyArray<SensitiveSite>,
): boolean {
  const haystack = title.trim().toLowerCase();
  if (haystack.length === 0) return false;
  return sites.some((site) => {
    const host = hostOfOrigin(site.origin);
    if (host.length >= 3 && haystack.includes(host)) return true;
    const label = site.label.trim().toLowerCase();
    return label.length >= 3 && haystack.includes(label);
  });
}

/**
 * The one decision both guards share. `sites` is null when the list could not
 * be read; `commandLine` is null when the window's pid could not be read.
 */
export function classifyBrowserWindow(input: {
  readonly windowClass: string;
  readonly title: string;
  readonly commandLine: string | null;
  readonly profileRoots: ReadonlyArray<string>;
  readonly sites: ReadonlyArray<SensitiveSite> | null;
}): BrowserWindowVerdict {
  if (!isBrowserWindowClass(input.windowClass)) return { kind: "allow" };
  if (input.commandLine === null) return { kind: "unidentified" };
  if (isSharedBrowserCommandLine(input.commandLine, input.profileRoots)) {
    return { kind: "shared" };
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
 * Wraps a command-line reader with a per-pid cache: the focus and point guards
 * run on every action, and `/proc` does not need reading twice for a window the
 * bot is working in. A miss is cached only briefly; the window is open, so a
 * readable process is readable now. PIDs are reused, hence the short life.
 */
export function makeCommandLineCache(
  read: (pid: number) => string | null = readProcessCommandLine,
  ttlMs = 30_000,
): (pid: number) => string | null {
  const cache = new Map<number, { readonly commandLine: string | null; readonly at: number }>();
  return (pid) => {
    const now = Date.now();
    const hit = cache.get(pid);
    if (hit !== undefined && now - hit.at < (hit.commandLine === null ? 5_000 : ttlMs)) {
      return hit.commandLine;
    }
    const commandLine = read(pid);
    if (cache.size >= 256) {
      for (const [key, entry] of cache) {
        if (now - entry.at >= ttlMs) cache.delete(key);
      }
      if (cache.size >= 256) cache.clear();
    }
    cache.set(pid, { commandLine, at: now });
    return commandLine;
  };
}
