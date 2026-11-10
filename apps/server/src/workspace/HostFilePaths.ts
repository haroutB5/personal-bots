// @effect-diagnostics nodeBuiltinImport:off - the home folder and path map come from the process, like the migration that reads the same map.
/** Where a chat path lives on this host and which host files may never be shown.
 * `hostPathCandidates` lists every place it can mean, best guess first.
 * `isProtectedHostPath` checks the requested path and the real path, so a
 * symlink cannot smuggle a secret out under a harmless name. */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { parsePathMap, rewriteStoredPath } from "../persistence/Migrations/113_LinuxPathRewrite.ts";

export interface HostPathContext {
  /** The chat's workspace root; relative paths try it first. */
  readonly workspaceRoot: string | undefined;
  /** The server user's home folder; `~/` and home-relative paths resolve here. */
  readonly homeDir: string;
  /** `T3CODE_PATH_MAP`, `C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/Claude/AI`. */
  readonly pathMap: string | undefined;
}

/** The running server's context: its user's home folder and the configured path map. */
export const currentHostPathContext = (workspaceRoot: string | undefined): HostPathContext => ({
  workspaceRoot,
  homeDir: NodeOS.homedir(),
  pathMap: process.env.T3CODE_PATH_MAP,
});

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const posix = NodePath.posix;

function isInside(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith("../") &&
    !posix.isAbsolute(relative)
  );
}

/**
 * Every absolute host path a chat-written path can mean, most likely first,
 * without duplicates. A relative path tries the workspace, then the home
 * folder; each stays inside its own base, so `..` cannot climb out of either.
 * A Windows path maps through the path map and nowhere else.
 */
export function hostPathCandidates(requested: string, context: HostPathContext): string[] {
  const trimmed = requested.trim();
  if (trimmed === "" || trimmed.includes("\0")) return [];
  const candidates: string[] = [];
  const add = (candidate: string) => {
    const normalized = posix.normalize(candidate);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };
  const home = posix.normalize(context.homeDir);

  if (WINDOWS_DRIVE.test(trimmed)) {
    const mapped = rewriteStoredPath(trimmed, parsePathMap(context.pathMap));
    if (mapped !== null) add(mapped);
    return candidates;
  }
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    const target = posix.join(home, trimmed.slice(1));
    if (target === home || isInside(home, target)) add(target);
    return candidates;
  }
  if (posix.isAbsolute(trimmed)) {
    add(trimmed);
    return candidates;
  }
  if (context.workspaceRoot !== undefined && context.workspaceRoot.trim() !== "") {
    const root = posix.normalize(context.workspaceRoot);
    const target = posix.join(root, trimmed);
    if (isInside(root, target)) add(target);
  }
  const homeTarget = posix.join(home, trimmed);
  if (isInside(home, homeTarget)) add(homeTarget);
  return candidates;
}

// Basenames that hold credentials wherever they sit. `.env.example` and its
// siblings are templates and stay readable.
const PROTECTED_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\..+)?$/i,
  /^auth\.json$/i,
  /^\.?credentials?(\..+)?$/i,
  /^\.?netrc$/i,
  /^_netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|kwl|gpg|asc)$/i,
  /\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$/i,
  /token/i,
  /^\.?pgpass$/i,
  /^\.my\.cnf$/i,
  /\.keyring(?:\.(?:bak|old|backup|save|\d+))?$/i,
  /^\.(?:bash|zsh|ash|dash|ksh|fish|sh|mysql|psql|python|node_repl|irb|sqlite|php|ruby|scala)_history(?:\.(?:bak|old|backup|save|\d+))?$/i,
  /^\.(?:history|zhistory)$/i,
  /^\.(?:lesshst|viminfo)$/i,
  /^\.claude\.json(?:\.(?:backup|bak|old|save))?$/i,
  /^recently-used\.xbel$/i,
  /^fish_history$/i,
  /^cookies(-journal)?$/i,
  /^login data(-journal)?$/i,
  /^local state$/i,
  /^web data(-journal)?$/i,
  /^logins\.json$/i,
  /^key[34]\.db$/i,
  /^signons\.sqlite$/i,
];
const TEMPLATE_ENV = /^\.env\.(example|sample|template|dist|defaults?)$/i;

// A folder anywhere in the path that holds credentials or machine state.
const PROTECTED_SEGMENTS = new Set([
  ".ssh",
  ".ssh2",
  ".gnupg",
  ".aws",
  ".kube",
  ".password-store",
  ".claude",
  ".codex",
  ".gemini",
  "secrets",
  "browser-profiles",
]);

// Absolute prefixes of the system: kernel views, devices and account databases.
const PROTECTED_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/run/secrets",
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/sudoers.d",
];

// The Bots data root keeps its database and settings beside the media folders.
// Only media folders are for showing; `browser-artifacts` holds the screenshots
// bots embed. Everything else under `userdata` stays private.
const SHOWABLE_BOTS_DATA_DIRS = new Set(["attachments", "browser-artifacts"]);
function isProtectedBotsData(segments: ReadonlyArray<string>): boolean {
  const index = segments.lastIndexOf("userdata");
  return index >= 0 && !SHOWABLE_BOTS_DATA_DIRS.has(segments[index + 1] ?? "");
}

const PROTECTED_CONFIG_DIRS = new Set([
  "gh",
  "glab-cli",
  "op",
  "gcloud",
  "azure",
  "rclone",
  "bitwarden",
  "bitwarden cli",
  "1password",
  "claude",
  "codex",
]);
const BROWSER_PROFILE_DIRS = new Set(["bravesoftware", "google-chrome", "chromium", "mozilla"]);
// Flatpak and snap roots keep the same credential stores under their own names.
const PROTECTED_APP_SEGMENTS = new Set([
  "com.bitwarden.desktop",
  "com.1password.1password",
  "kwalletd",
]);
// Machine state the CLIs keep outside ~/.config and ~/.claude.
const PROTECTED_STATE_DIRS: ReadonlyArray<ReadonlyArray<string>> = [
  [".cache", "claude"],
  [".local", "state", "claude"],
  [".local", "share", "claude"],
  [".local", "share", "zsh"],
];
function hasSegmentSequence(
  segments: ReadonlyArray<string>,
  sequence: ReadonlyArray<string>,
): boolean {
  const first = sequence[0] ?? "";
  for (let index = 0; index + sequence.length <= segments.length; index += 1) {
    if (segments[index] !== first) continue;
    if (sequence.every((segment, offset) => segments[index + offset] === segment)) return true;
  }
  return false;
}
function isProtectedConfigFolder(segments: ReadonlyArray<string>): boolean {
  // gh keeps its token in ~/.config/gh/hosts.yml; the CLI logins live in these.
  for (let index = 0; index + 1 < segments.length; index += 1) {
    const child = (segments[index + 1] ?? "").toLowerCase();
    if (segments[index] === ".config") {
      if (PROTECTED_CONFIG_DIRS.has(child) || BROWSER_PROFILE_DIRS.has(child)) return true;
    }
    if (segments[index] === ".docker" && child === "config.json") return true;
  }
  if (segments.some((segment) => PROTECTED_APP_SEGMENTS.has(segment.toLowerCase()))) return true;
  return PROTECTED_STATE_DIRS.some((sequence) => hasSegmentSequence(segments, sequence));
}

/** True when a path names a file that must not be read, shown or downloaded. */
export function isProtectedHostPath(absolutePath: string): boolean {
  const normalized = posix.normalize(absolutePath.replaceAll("\\", "/"));
  if (
    PROTECTED_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  const segments = normalized.split("/").filter((segment) => segment !== "");
  const basename = segments.at(-1) ?? "";
  if (segments.slice(0, -1).some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase())))
    return true;
  if (isProtectedBotsData(segments.slice(0, -1)) || isProtectedConfigFolder(segments)) return true;
  if (TEMPLATE_ENV.test(basename)) return false;
  return PROTECTED_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}
