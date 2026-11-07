/**
 * Server files a bot must not read or change: secrets read-write denied, the
 * SQLite database and sidecars write-denied (reads stay open), logs not denied.
 * Best effort: each provider's permission engine, not an OS boundary.
 * @module provider/botProtectedPaths
 */
export interface BotProtectedPathsInput {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly secretsDir: string;
  readonly logsDir: string;
}

/**
 * Kill switch: `PERSONAL_BOT_STATE_DENY=off` (also 0 / false / no, and the
 * `T3CODE_` spelling) starts bot sessions without these deny rules. Read when a
 * session starts, so an idle restart applies it.
 */
export const botStateDenyEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = (env.PERSONAL_BOT_STATE_DENY ?? env.T3CODE_PERSONAL_BOT_STATE_DENY)
    ?.trim()
    .toLowerCase();
  return raw === undefined || !["off", "0", "false", "no"].includes(raw);
};

export interface BotProtectedPath {
  readonly path: string;
  /** A directory protects everything under it; a file protects only itself. */
  readonly kind: "dir" | "file";
  /** `read-write` denies reading and changing; `write` denies changing only. */
  readonly access: "read-write" | "write";
}

/** SQLite files next to the database: write-ahead log, shared memory, rollback journal. */
const BOT_PROTECTED_DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/** How many trailing segments the tail rules keep: specific enough to stay out of unrelated folders. */
const TAIL_SEGMENT_COUNT = 3;

/** The protected paths exactly as the server knows them (native separators). */
export function botProtectedPaths(paths: BotProtectedPathsInput): ReadonlyArray<BotProtectedPath> {
  return [
    { path: paths.secretsDir, kind: "dir", access: "read-write" },
    { path: paths.dbPath, kind: "file", access: "write" },
    ...BOT_PROTECTED_DB_SIDECAR_SUFFIXES.map((suffix) => ({
      path: `${paths.dbPath}${suffix}`,
      kind: "file" as const,
      access: "write" as const,
    })),
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
 * The path as a Claude Code `Read`/`Edit` rule anchor: `//` is the root and
 * Windows drives normalize to `/c/...`. Relative paths and UNC return undefined.
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
 * Claude Code `permissions.deny` rules for a bot, in flag settings so they hold
 * with `settingSources: []` and in every mode. Read/Edit cover the file tools
 * and recognized file commands; Bash/PowerShell rules are string matches, not
 * a boundary.
 */
export function buildClaudeBotPermissionDeny(paths: BotProtectedPathsInput): Array<string> {
  const rules: Array<string> = [];
  for (const { path, kind, access } of botProtectedPaths(paths)) {
    for (const anchor of [claudeFileRuleAnchor(path), claudeTailRuleAnchor(path)]) {
      if (anchor === undefined) continue;
      // A bare anchor matches the folder itself (what a Grep/Glob `path` names)
      // and, as a gitignore pattern, everything under it; `/**` states it plainly.
      const specifiers = kind === "dir" ? [anchor, `${anchor}/**`] : [anchor];
      for (const specifier of specifiers) {
        // A Read deny also blocks Edit and Write; an Edit deny leaves reading open.
        if (access === "read-write") rules.push(`Read(${specifier})`);
        rules.push(`Edit(${specifier})`);
      }
    }
  }
  // Command-text rules would also stop reads (`sqlite3 state.sqlite`, `cat`), so
  // they cover the secrets folder only.
  const bashPatterns = new Set<string>();
  const powershellPatterns = new Set<string>();
  for (const path of [paths.secretsDir]) {
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
  for (const pattern of bashPatterns) rules.push(`Bash(${pattern})`);
  for (const pattern of powershellPatterns) rules.push(`PowerShell(${pattern})`);
  return [...new Set(rules)];
}

/**
 * OpenCode session permission rules for a bot, appended after the mode's rules
 * (last match wins, so they override a full-access `*` allow). Patterns are
 * full-string wildcards; bash rules are string matches, not a boundary.
 */
export interface OpenCodeDenyRule {
  readonly permission: string;
  readonly pattern: string;
  readonly action: "deny";
}

/**
 * OpenCode session permission rules for a bot, appended after the mode's rules
 * (last match wins, so they override a full-access `*` allow). Patterns are
 * full-string wildcards; bash rules are string matches, not a boundary.
 */
export function buildOpenCodeBotPermissionRules(
  paths: BotProtectedPathsInput,
): Array<OpenCodeDenyRule> {
  const rules: Array<OpenCodeDenyRule> = [];
  const deny = (permission: string, pattern: string) =>
    rules.push({ permission, pattern, action: "deny" });
  for (const { path, kind, access } of botProtectedPaths(paths)) {
    const parsed = parseAbsolutePath(path);
    if (!parsed) continue;
    const tail = tailSegments(path).join("/");
    const bases = [forwardSlashForm(parsed), ...(tail ? [`*${tail}`] : [])];
    for (const base of bases) {
      for (const pattern of kind === "dir" ? [base, `${base}/*`] : [base]) {
        deny("edit", pattern);
        if (access === "write") continue;
        deny("read", pattern);
        deny("list", pattern);
        if (kind === "dir") deny("external_directory", pattern);
      }
    }
  }
  const bashPatterns = new Set<string>();
  for (const path of [paths.secretsDir]) {
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
  for (const pattern of bashPatterns) deny("bash", pattern);
  return rules;
}
