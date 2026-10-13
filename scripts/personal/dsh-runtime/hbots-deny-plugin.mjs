/**
 * hbots bot-state deny plugin for the DeepSeek Harness (dsh).
 *
 * Ships static with the runtime pin (install-dsh.ps1 copies it into the
 * runtime folder) and is loaded by one `insert` row in every per-chat launch
 * patch. The row carries the real paths, so this file never has to know a
 * data root.
 *
 * It restores, for dsh, the guardrail the Claude Code engine gives hbots bots
 * (`apps/server/src/personal/secrets/botProtectedPaths.ts`):
 *   - no reading or writing the sealed secret store, which holds the
 *     data-encryption key;
 *   - no writing the SQLite database or its sidecars (reading stays open on
 *     purpose: the dev team reads the live database to confirm releases);
 *   - no writing the harness home, where `cordis.patch.yml` would change the
 *     harness every other bot in that data root starts from.
 *
 * It is a tool-level deny, NOT an OS boundary, exactly like Claude's: the
 * shell rule matches command text, so a path built inside a script is not
 * stopped. A separate OS user for the server is the real fix.
 *
 * The hook runs for every mode: PTC `run_code` sub-dispatch and subagents go
 * through the same tool scheduler.
 */

/** Case- and separator-insensitive form, so Windows spellings all compare equal. */
const norm = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** True when `candidate` is the root itself or sits under it. */
const under = (roots, candidate) => {
  const target = norm(candidate);
  if (target.length === 0) return false;
  return roots.some((root) => target === root || target.startsWith(`${root}/`));
};

/** The file tools that name a path, and whether each may read the read-deny roots. */
const FILE_TOOLS = new Map([
  ["read", true],
  ["read_image", true],
  ["edit", false],
  ["write", false],
  ["multiedit", false],
  ["apply_patch", false],
]);

const SEARCH_TOOLS = new Set(["glob", "grep"]);
const SHELL_TOOLS = new Set(["pwsh", "bash"]);

const DENY_REASON = "blocked: path is bot state protected by the hbots server";

/** Paths a route string might name, from `file_path`, `path` and `paths` arguments. */
function pathArguments(args) {
  const values = [];
  for (const field of ["file_path", "path", "filePath", "filename"]) {
    if (typeof args[field] === "string") values.push(args[field]);
  }
  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) if (typeof entry === "string") values.push(entry);
  }
  return values;
}

/**
 * True when a path reaches a protected folder by a spelling the full-path
 * comparison misses: a Windows admin share (`//localhost/c$/...`), the
 * `\\?\` long-path prefix, or a `..\..\` route from somewhere else. They all
 * end in the same trailing segments, so a tail of the folder still matches.
 * The same trick the server's Claude Code rules use, and the same false
 * positives they accept.
 */
const tailMatches = (tails, candidate) => {
  const target = norm(candidate);
  if (target.length === 0) return false;
  return tails.some((tail) => target.startsWith(tail) || target.includes(`/${tail}`));
};

/** Command text a shell tool would run. */
function commandText(args) {
  for (const field of ["command", "cmd", "script", "input"]) {
    if (typeof args[field] === "string") return args[field];
  }
  return "";
}

export const name = "hbots-deny";

export function apply(ctx, config) {
  const readWrite = (config?.denyReadWrite ?? []).map(norm).filter(Boolean);
  const writeOnly = (config?.denyWrite ?? []).map(norm).filter(Boolean);
  // The last two segments of the protected folders, in both separator styles:
  // the full path misses `\\localhost\c$\...` and `..\..\` routes that reach
  // the same folder.
  const commandForms = [];
  const readWriteTails = [];
  for (const root of readWrite) {
    commandForms.push(root);
    const segments = root.split("/").filter(Boolean);
    const commandTail = segments.slice(-2).join("/");
    if (commandTail.includes("/")) commandForms.push(commandTail);
    const pathTail = segments.slice(-3).join("/");
    if (pathTail.includes("/")) readWriteTails.push(pathTail);
  }

  ctx.on("tools/pre-execute", (exec, next) => {
    try {
      const args = exec?.arguments ?? {};
      const paths = pathArguments(args);
      if (FILE_TOOLS.has(exec?.name)) {
        const mayRead = FILE_TOOLS.get(exec.name) === true;
        for (const candidate of paths) {
          if (under(readWrite, candidate) || tailMatches(readWriteTails, candidate)) {
            return { kind: "deny", reason: DENY_REASON };
          }
          if (!mayRead && under(writeOnly, candidate)) {
            return { kind: "deny", reason: DENY_REASON };
          }
        }
      }
      if (SEARCH_TOOLS.has(exec?.name)) {
        for (const candidate of paths) {
          if (under(readWrite, candidate) || tailMatches(readWriteTails, candidate)) {
            return { kind: "deny", reason: DENY_REASON };
          }
        }
      }
      if (SHELL_TOOLS.has(exec?.name)) {
        const command = norm(commandText(args));
        if (command.length > 0 && commandForms.some((form) => command.includes(form))) {
          return { kind: "deny", reason: DENY_REASON };
        }
      }
    } catch {
      // A guardrail that throws must never break the tool it guards.
    }
    return next();
  });
}
