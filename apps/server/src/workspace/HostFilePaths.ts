// @effect-diagnostics nodeBuiltinImport:off - the home folder and path map come from the process, like the migration that reads the same map.
/**
 * Where a path written in a bot chat really lives on this host, and which host
 * files may never be shown.
 *
 * Bots write file paths in the shapes they know: relative to the workspace,
 * relative to the home folder (`.personal-bots/qa/x/RESULT.md`), `~/...`,
 * absolute Linux paths, and the Windows paths of the old machine
 * (`C:/Users/Ht/...`, `C:/Claude/AI/...`). `hostPathCandidates` lists every
 * place such a path can mean, best guess first; the reader opens the first one
 * that exists. Pure on purpose: no file is touched here.
 *
 * `isProtectedHostPath` is the deny list every read and every signed download
 * of a host file passes through. It looks at the path only, so it is applied to
 * the requested path and again to the resolved real path (a symlink cannot
 * smuggle a secret out under a harmless name).
 */
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
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i,
  /\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$/i,
  /token/i,
  /^\.?pgpass$/i,
  /^\.my\.cnf$/i,
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
  ".gnupg",
  ".aws",
  ".kube",
  ".password-store",
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

// The Bots data root keeps its database, its sealed secret store and its
// settings beside the media folders; only the media folders are for showing.
// `browser-artifacts` is where the preview tool writes the screenshots it tells
// bots to embed, so it must be readable through a signed asset URL like
// `attachments`; everything else under `userdata` stays private.
const SHOWABLE_BOTS_DATA_DIRS = new Set(["attachments", "browser-artifacts"]);
function isProtectedBotsData(segments: ReadonlyArray<string>): boolean {
  const index = segments.lastIndexOf("userdata");
  return index >= 0 && !SHOWABLE_BOTS_DATA_DIRS.has(segments[index + 1] ?? "");
}

const PROTECTED_CONFIG_DIRS = new Set(["gh", "glab-cli", "op", "gcloud", "azure", "rclone"]);
const BROWSER_PROFILE_DIRS = new Set(["bravesoftware", "google-chrome", "chromium", "mozilla"]);
function isProtectedConfigFolder(segments: ReadonlyArray<string>): boolean {
  // gh keeps its token in ~/.config/gh/hosts.yml; the CLI logins live in these.
  for (let index = 0; index + 1 < segments.length; index += 1) {
    const child = (segments[index + 1] ?? "").toLowerCase();
    if (segments[index] === ".config") {
      if (PROTECTED_CONFIG_DIRS.has(child) || BROWSER_PROFILE_DIRS.has(child)) return true;
    }
    if (segments[index] === ".docker" && child === "config.json") return true;
  }
  return false;
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
