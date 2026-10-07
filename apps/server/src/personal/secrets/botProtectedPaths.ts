/**
 * Server files a personal bot's coding session must not read or change: the
 * sealed secret files and data-encryption key (`secretsDir`), the SQLite
 * database and its sidecars, and the logs (server trace, provider event logs).
 * Bots run as the same OS user as the server, so this is a best-effort deny
 * built on each provider's own permission engine, not an OS boundary. This
 * module is pure: it turns the paths into the rule syntax each provider reads.
 *
 * Per provider (what is enforced is stated at each builder):
 * - Claude Code: `permissions.deny` rules, enforced in every permission mode.
 * - OpenCode: session permission rules appended last (last match wins).
 * - Codex: nothing here. A bot session runs `danger-full-access`, which the
 *   sandbox cannot restrict, and the permission-profile `none` entries that
 *   could deny reads are ignored once the legacy `sandbox` value is sent (and
 *   on Windows the default sandbox backend refuses to start with them); see
 *   `CodexAdapter.ts`.
 *
 * Case: Windows paths are case-insensitive on disk, but only OpenCode (on
 * win32) and PowerShell rules compare case-insensitively. The Claude Bash rules
 * emit the drive letter in both cases; other letter-case differences, 8.3 short
 * names and junction targets that rename a folder are not covered.
 *
 * @module personal/secrets/botProtectedPaths
 */
import type { ServerDerivedPaths } from "../../config.ts";

/**
 * Kill switch: `PERSONAL_BOT_STATE_DENY=off` (also 0 / false / no, and the
 * `T3CODE_` spelling) starts bot sessions without these deny rules. Read when a
 * session starts, so an idle restart applies it. It exists because the rules
 * also stop the dev-team bots from reading the live state database and logs for
 * their own work (e.g. a bot reading chat history from `state.sqlite`).
 */
export const botStateDenyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = (env.PERSONAL_BOT_STATE_DENY ?? env.T3CODE_PERSONAL_BOT_STATE_DENY)
    ?.trim()
    .toLowerCase();
  return raw === undefined || !["off", "0", "false", "no"].includes(raw);
};

export type BotProtectedPathsInput = Pick<
  ServerDerivedPaths,
  "stateDir" | "dbPath" | "secretsDir" | "logsDir"
>;

export interface BotProtectedPath {
  readonly path: string;
  /** A directory protects everything under it; a file protects only itself. */
  readonly kind: "dir" | "file";
}

/** SQLite files next to the database: write-ahead log, shared memory, rollback journal. */
export const BOT_PROTECTED_DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** How many trailing segments the tail rules keep: specific enough to stay out of unrelated folders. */
const TAIL_SEGMENT_COUNT = 3;

/** The protected paths exactly as the server knows them (native separators). */
export function botProtectedPaths(paths: BotProtectedPathsInput): ReadonlyArray<BotProtectedPath> {
  return [
    { path: paths.secretsDir, kind: "dir" },
    { path: paths.dbPath, kind: "file" },
    ...BOT_PROTECTED_DB_SIDECAR_SUFFIXES.map((suffix) => ({
      path: `${paths.dbPath}${suffix}`,
      kind: "file" as const,
    })),
    { path: paths.logsDir, kind: "dir" },
  ];
}

interface ParsedAbsolutePath {
  readonly kind: "drive" | "unc" | "posix";
  /** Drive letter as written for `drive`, else undefined. */
  readonly drive: string | undefined;
  readonly segments: ReadonlyArray<string>;
}

/** Splits an absolute path on either separator; relative paths return undefined. */
function parseAbsolutePath(path: string): ParsedAbsolutePath | undefined {
  const drive = /^([A-Za-z]):[\\/]/.exec(path);
  const unc = /^[\\/]{2}[^\\/]/.test(path);
  const posix = /^\/(?!\/)/.test(path);
  if (!drive && !unc && !posix) return undefined;
  const rest = drive ? path.slice(3) : path;
  return {
    kind: drive ? "drive" : unc ? "unc" : "posix",
    drive: drive?.[1],
    segments: rest.split(/[\\/]+/).filter((segment) => segment.length > 0),
  };
}

/** `C:/Users/x`, `/usr/x`, `//server/share/x`: forward slashes, drive letter as written. */
function forwardSlashForm(parsed: ParsedAbsolutePath): string {
  const joined = parsed.segments.join("/");
  if (parsed.drive !== undefined) return `${parsed.drive}:/${joined}`;
  return parsed.kind === "unc" ? `//${joined}` : `/${joined}`;
}

/**
 * Every spelling of the path a shell command could contain, for the rules that
 * match command text: forward slashes, the Git Bash `/c/...` form, and
 * backslashes, with the drive letter in both cases. UNC paths keep one
 * forward-slash and one backslash form.
 */
export function botProtectedCommandForms(path: string): ReadonlyArray<string> {
  const parsed = parseAbsolutePath(path);
  if (!parsed) return [];
  const slashed = parsed.segments.join("/");
  const backslashed = parsed.segments.join("\\");
  if (parsed.drive !== undefined) {
    const lower = parsed.drive.toLowerCase();
    const upper = parsed.drive.toUpperCase();
    return [
      `${upper}:/${slashed}`,
      `${lower}:/${slashed}`,
      `/${lower}/${slashed}`,
      `${upper}:\\${backslashed}`,
      `${lower}:\\${backslashed}`,
    ];
  }
  return parsed.kind === "unc" ? [`//${slashed}`, `\\\\${backslashed}`] : [`/${slashed}`];
}

/**
 * The last few segments of the path. The full path misses spellings that reach
 * the same file another way (a Windows admin share `\\localhost\c$\...`, the
 * `\\?\` long-path prefix, a `..\` route from another folder), but those all
 * end in the same segments, so a rule on the tail still matches them.
 */
function tailSegments(path: string): ReadonlyArray<string> {
  const segments = parseAbsolutePath(path)?.segments ?? [];
  // A one-segment tail (a path directly under the root) would match too much.
  return segments.length >= 2 ? segments.slice(-TAIL_SEGMENT_COUNT) : [];
}

/** Characters gitignore (the Claude Read/Edit rule grammar) treats as syntax. */
function escapeGitignore(text: string): string {
  return text.replace(/[[\]*?]/g, "\\$&");
}

/**
 * The path as a Claude Code `Read`/`Edit` rule anchor: `//` is the filesystem
 * root, and Windows `C:\Users\x` is normalized to `/c/Users/x` before matching
 * (https://code.claude.com/docs/en/permissions, "Read and Edit"). Relative
 * paths and UNC shares return undefined, so no rule is emitted that could be
 * silently ignored.
 */
export function claudeFileRuleAnchor(path: string): string | undefined {
  const parsed = parseAbsolutePath(path);
  if (!parsed || parsed.kind === "unc") return undefined;
  const joined = escapeGitignore(parsed.segments.join("/"));
  return parsed.drive !== undefined ? `//${parsed.drive.toLowerCase()}/${joined}` : `//${joined}`;
}

/** `//**` plus the tail segments: a Read/Edit anchor that matches under any root or share. */
export function claudeTailRuleAnchor(path: string): string | undefined {
  const tail = tailSegments(path);
  return tail.length > 0 ? `//**/${escapeGitignore(tail.join("/"))}` : undefined;
}

/**
 * Claude Code `permissions.deny` rules for a bot session (flag settings, so
 * they hold with `settingSources: []`). Measured on Windows with CLI 2.1.291
 * under `--permission-mode bypassPermissions` against a mock API; limits:
 * - `Read(path)` and `Edit(path)` rules cover the built-in file tools. A Read
 *   deny also blocks Edit and Write on the path, and Grep and Glob honor the
 *   Read rules. `Write(path)`, `Glob(path)` and `Grep(path)` rules are accepted
 *   but never consulted, so none are emitted.
 * - Read/Edit rules also apply to the file commands Claude Code recognizes in
 *   Bash and PowerShell (`cat`, `Get-Content`, `cp`, `Copy-Item`, redirects)
 *   when they name the file. They do not apply to `python -c` or any script
 *   that opens the file itself.
 * - `Bash(*text*)` and `PowerShell(*text*)` match command text containing the
 *   path (or its tail), in any subcommand. They are string matches, not a
 *   boundary: a path built in code, an environment variable, a glob, an 8.3
 *   short name, or `open('../x/secrets')` inside a script is not matched.
 * - Deny rules apply in every permission mode, `bypassPermissions` and `auto`
 *   included (https://code.claude.com/docs/en/permission-modes).
 */
export function buildClaudeBotPermissionDeny(paths: BotProtectedPathsInput): Array<string> {
  const rules: Array<string> = [];
  for (const { path, kind } of botProtectedPaths(paths)) {
    for (const anchor of [claudeFileRuleAnchor(path), claudeTailRuleAnchor(path)]) {
      if (anchor === undefined) continue;
      // A bare anchor matches the folder itself (what a Grep/Glob `path` names)
      // and, as a gitignore pattern, everything under it; `/**` states it plainly.
      const specifiers = kind === "dir" ? [anchor, `${anchor}/**`] : [anchor];
      for (const specifier of specifiers) rules.push(`Read(${specifier})`, `Edit(${specifier})`);
    }
  }
  const bashPatterns = new Set<string>();
  const powershellPatterns = new Set<string>();
  for (const path of [paths.secretsDir, paths.dbPath, paths.logsDir]) {
    const tail = tailSegments(path);
    const texts = [
      ...botProtectedCommandForms(path),
      ...(tail.length > 0 ? [tail.join("/"), tail.join("\\")] : []),
    ];
    for (const text of texts) {
      bashPatterns.add(`*${text}*`);
      // PowerShell rules compare case-insensitively, so one drive-letter case
      // is enough, and its tool never sees the Git Bash `/c/...` spelling.
      if (!/^\/[a-z]\//.test(text) && !/^[a-z]:/.test(text)) powershellPatterns.add(`*${text}*`);
    }
  }
  const dbName = paths.dbPath.split(/[\\/]/).at(-1);
  if (dbName !== undefined && dbName.length > 0) {
    bashPatterns.add(`*${dbName}*`);
    powershellPatterns.add(`*${dbName}*`);
  }
  for (const pattern of bashPatterns) rules.push(`Bash(${pattern})`);
  for (const pattern of powershellPatterns) rules.push(`PowerShell(${pattern})`);
  return [...new Set(rules)];
}

/** The slice of OpenCode's `PermissionRuleset` entry this module emits. */
export interface OpenCodeDenyRule {
  readonly permission: string;
  readonly pattern: string;
  readonly action: "deny";
}

/**
 * OpenCode session permission rules for a bot, to append after the mode's
 * rules (the last matching rule wins, so a `*` allow in full-access mode is
 * overridden). Patterns are full-string wildcards (`*` any text, `?` one
 * character); on win32 both sides have `\` turned into `/` and compare
 * case-insensitively (OpenCode `util/wildcard.ts`).
 * - `read`, `edit` (edit, write and patch), `list`: the path, `<dir>/*`, and
 *   the same for the tail segments (`*<tail>`, `*<tail>/*`).
 * - `external_directory`: the folders and `<dir>/*`, which also gates the
 *   path arguments of the bash commands OpenCode parses and of glob and grep.
 *   A file in the state directory has no folder rule of its own, so the
 *   SQLite files rely on `read`/`edit`.
 * - `bash`: `*path*` and `*tail*` against the command text, a string match
 *   only. It does not catch variables, globs, 8.3 names or code that builds
 *   the path.
 * Not measured against a running OpenCode: the evidence is the docs, the
 * pattern matcher source and the SDK types.
 * https://opencode.ai/docs/permissions/
 */
export function buildOpenCodeBotPermissionRules(
  paths: BotProtectedPathsInput,
): Array<OpenCodeDenyRule> {
  const rules: Array<OpenCodeDenyRule> = [];
  const deny = (permission: string, pattern: string) =>
    rules.push({ permission, pattern, action: "deny" });
  for (const { path, kind } of botProtectedPaths(paths)) {
    const parsed = parseAbsolutePath(path);
    if (!parsed) continue;
    const tail = tailSegments(path).join("/");
    const bases = [forwardSlashForm(parsed), ...(tail ? [`*${tail}`] : [])];
    for (const base of bases) {
      for (const pattern of kind === "dir" ? [base, `${base}/*`] : [base]) {
        deny("read", pattern);
        deny("edit", pattern);
        deny("list", pattern);
        if (kind === "dir") deny("external_directory", pattern);
      }
    }
  }
  const bashPatterns = new Set<string>();
  for (const path of [paths.secretsDir, paths.dbPath, paths.logsDir]) {
    const parsed = parseAbsolutePath(path);
    if (!parsed) continue;
    bashPatterns.add(`*${forwardSlashForm(parsed)}*`);
    // The Git Bash spelling is a different string once backslashes are flipped.
    if (parsed.drive !== undefined) {
      bashPatterns.add(`*/${parsed.drive.toLowerCase()}/${parsed.segments.join("/")}*`);
    }
    const tail = tailSegments(path).join("/");
    if (tail) bashPatterns.add(`*${tail}*`);
  }
  const dbName = paths.dbPath.split(/[\\/]/).at(-1);
  if (dbName !== undefined && dbName.length > 0) bashPatterns.add(`*${dbName}*`);
  for (const pattern of bashPatterns) deny("bash", pattern);
  return rules;
}
