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
 * From 1.66.66 every candidate path is resolved against the calling session's
 * working directory and canonicalized before the string comparison. dsh
 * 0.2.0-rc.2 resolves `read`/`write`/`edit`/search paths against the session
 * cwd (`exec.agent.session.header.cwd`); 0.2.1 adds a `working_directory`
 * tool and resolves against the session projection that tool changes. A raw
 * string comparison only sees the spelling the model sent, so `secrets/x`
 * from a data-root cwd, `..\dev\userdata\secrets\x` from a workspace cwd,
 * `\\?\C:\...`, `C:\...\\secrets\\x` and an 8.3 short name all used to pass.
 * The canonical form is compared against the canonical protected roots (and
 * the tail rules stay for admin shares and unresolved spellings).
 *
 * It is a tool-level deny, NOT an OS boundary, exactly like Claude's: the
 * shell rule matches command text, so a path built inside a script is not
 * stopped. From 1.66.67 the same command-text rule also scans the PTC
 * `run_code` program text, and the literal path strings inside it are
 * resolved against the session cwd, so a plain `fs.readFileSync(
 * '../userdata/secrets/x')` no longer reads the store. A path the program
 * assembles at run time (a variable, a join, a template) is still not
 * stopped: a separate OS user for the server is the real fix.
 *
 * The hook runs for every mode: PTC `run_code` sub-dispatch and subagents go
 * through the same tool scheduler.
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";

/** Case- and separator-insensitive form, so Windows spellings all compare equal. */
const norm = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** True when `candidate` is the root itself or sits under it. */
const under = (roots, candidate) => {
  const target = norm(candidate);
  if (target.length === 0) return false;
  return roots.some((root) => {
    const base = norm(root);
    return base.length > 0 && (target === base || target.startsWith(`${base}/`));
  });
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
const PTC_TOOLS = new Set(["run_code"]);
const WORKING_DIRECTORY_TOOLS = new Set(["working_directory", "tool-working-directory"]);

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

/** The working directory a shell tool would run in. */
function shellWorkdirArguments(args) {
  const values = [];
  for (const field of ["workdir", "cwd"]) {
    if (typeof args[field] === "string") values.push(args[field]);
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

/**
 * Program text a PTC tool would run. `run_code` carries a JavaScript program
 * that calls the generated tool SDK, so the program text is the shell
 * equivalent: its static path spellings are what the command-text rule can
 * see. A path the program builds at run time is invisible here, the same
 * limit the shell rule has.
 */
function programText(args) {
  for (const field of ["code", "program"]) {
    if (typeof args[field] === "string") return args[field];
  }
  return "";
}

/**
 * The string literals in a program, bounded: the cheap static look for a
 * literal path. Escapes are consumed, so a quoted quote does not split one.
 */
function literalStrings(code) {
  const values = [];
  const pattern = /([`'"])(?:\\.|(?!\1)[^\\\r\n]){0,400}\1/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    values.push(match[0].slice(1, -1));
    if (values.length >= 200) break;
  }
  return values;
}

/** Windows long-path prefixes obscure a drive letter; strip them before resolving. */
function stripLongPathPrefix(value) {
  const text = String(value);
  if (/^[\\/]{2}\?[\\/]unc[\\/]/i.test(text)) {
    return `\\\\${text.replace(/^[\\/]{2}\?[\\/]unc[\\/]/i, "").replace(/\//g, "\\")}`;
  }
  if (/^[\\/]{2}\?[\\/]/.test(text)) return text.slice(4).replace(/\//g, "\\");
  if (/^[\\/]{2}\.[\\/]/.test(text)) return text.slice(4).replace(/\//g, "\\");
  return text.replace(/\//g, "\\");
}

/** path.win32 keeps the comparison identical on every OS the plugin is tested on. */
const WIN = path.win32;

/**
 * The absolute form of a model-supplied path, resolved the way dsh's fs
 * resolve does (`cwd` is the session's working directory).
 */
const resolvePath = (candidate, cwd) =>
  WIN.normalize(WIN.resolve(cwd ?? process.cwd(), stripLongPathPrefix(candidate)));

/**
 * A canonical form that survives realpath: 8.3 short names, junctions,
 * symlinks, trailing dots and duplicate separators all become the real path.
 * A target that does not exist (a write) is canonicalized from its nearest
 * existing ancestor plus the remainder. UNC paths are returned normalized and
 * never touched over the network; the tail rules still cover them.
 */
function canonicalPath(candidate, cwd) {
  try {
    const resolved = resolvePath(candidate, cwd);
    if (/^\\\\[^?.\\]/u.test(resolved)) return resolved;
    let probe = resolved;
    const remainder = [];
    for (let depth = 0; depth < 32; depth += 1) {
      try {
        const real = realpathSync.native(probe);
        return remainder.length === 0 ? real : WIN.join(real, ...remainder.reverse());
      } catch {
        const parent = WIN.dirname(probe);
        if (parent === probe) return resolved;
        remainder.push(WIN.basename(probe));
        probe = parent;
      }
    }
    return resolved;
  } catch {
    return undefined;
  }
}

/** True when a value looks absolute on Windows (drive, UNC or rooted). */
function isAbsoluteLike(value) {
  try {
    return WIN.isAbsolute(stripLongPathPrefix(value));
  } catch {
    return false;
  }
}

/**
 * The calling session's current directory. 0.2.1 keeps the mutable value in
 * the workingDirectory projection; 0.2.0 only has the session header. A
 * failure to read either is a missing cwd, never a crash.
 */
function sessionCwd(ctx, exec) {
  try {
    const session = exec?.agent?.session;
    if (session === undefined) return undefined;
    const service = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
    if (service !== undefined && typeof service.get === "function") {
      const cwd = service.get(session);
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    }
    const header = session?.header?.cwd;
    if (typeof header === "string" && header.length > 0) return header;
  } catch {
    // fall through: a missing cwd is handled by the relative-name rule
  }
  return undefined;
}

export const name = "hbots-deny";

export function apply(ctx, config) {
  const readWrite = (config?.denyReadWrite ?? []).map(norm).filter(Boolean);
  const writeOnly = (config?.denyWrite ?? []).map(norm).filter(Boolean);
  const readRoots = readWrite.map((root) => canonicalPath(root, undefined)).filter(Boolean);
  const writeRoots = writeOnly.map((root) => canonicalPath(root, undefined)).filter(Boolean);
  // The last two segments of the protected folders, in both separator styles:
  // the full path misses `\\localhost\c$\...` and `..\..\` routes that reach
  // the same folder.
  const commandForms = [];
  const readWriteTails = [];
  const protectedRelativeTails = [];
  for (const root of readWrite) {
    commandForms.push(root);
    const segments = root.split("/").filter(Boolean);
    const commandTail = segments.slice(-2).join("/");
    if (commandTail.includes("/")) commandForms.push(commandTail);
    const pathTail = segments.slice(-3).join("/");
    if (pathTail.includes("/")) readWriteTails.push(pathTail);
    // No cwd at all: a relative path that begins at a protected folder or at
    // its parent is denied rather than guessed.
    for (const depth of [2, 3]) {
      const tail = segments.slice(-depth).join("/");
      if (tail.includes("/")) protectedRelativeTails.push(tail);
    }
  }
  // The last segment of every protected root, plus each protected file's own
  // name: relative paths are denied when no cwd is visible.
  const protectedFirstSegments = new Set(
    [...readWrite, ...writeOnly]
      .map((root) => root.split("/").filter(Boolean).at(-1))
      .filter((segment) => segment !== undefined && segment.length > 0),
  );
  // The parent of each read-protected root. A shell started in the data root
  // could read `secrets\x` without its command text naming `userdata/secrets`,
  // so a workdir at or below that parent is denied. Write roots are guarded
  // themselves, not their parent: in production the harness home
  // (`<baseDir>\dsh`) sits beside the bot workspace
  // (`<baseDir>\personal-workspace`), so its parent would deny every workdir
  // in the workspace.
  const protectedParents = [
    ...readRoots.map((root) => norm(WIN.dirname(root))),
    ...writeRoots.map((root) => norm(root)),
  ].filter(Boolean);

  const canonicalHits = (candidate, cwd, roots, tails) => {
    const canonical = canonicalPath(candidate, cwd);
    if (canonical !== undefined) {
      if (under(roots, canonical) || tailMatches(tails, canonical)) return true;
    }
    // Raw fallback for spellings realpath cannot open (admin shares, odd
    // payloads) and for the no-cwd case.
    if (under(roots, candidate) || tailMatches(tails, candidate)) return true;
    return false;
  };

  const relativeNameHits = (candidate) => {
    const target = norm(candidate);
    if (target.length === 0) return false;
    if (tailMatches(protectedRelativeTails, target)) return true;
    const segments = target
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
    // Only the first real segment, so a legitimate folder that happens to be
    // named `secrets` deeper in the workspace is not swept up.
    return segments.length > 0 && protectedFirstSegments.has(segments[0]);
  };

  const pathDenied = (candidate, cwd, roots, tails) => {
    try {
      if (canonicalHits(candidate, cwd, roots, tails)) return true;
      // A relative path with no session cwd cannot be resolved: if it names a
      // protected folder or file, deny it rather than allow it.
      if (cwd === undefined && !isAbsoluteLike(candidate)) return relativeNameHits(candidate);
    } catch {
      // Never fail open on a path this guard cannot evaluate.
      return true;
    }
    return false;
  };

  const insideProtectedParent = (candidate, cwd) => {
    const canonical = canonicalPath(candidate, cwd);
    if (canonical === undefined) return false;
    return under(protectedParents, canonical);
  };

  ctx.on("tools/pre-execute", (exec, next) => {
    try {
      const args = exec?.arguments ?? {};
      const cwd = sessionCwd(ctx, exec);
      const paths = pathArguments(args);
      if (FILE_TOOLS.has(exec?.name)) {
        const mayRead = FILE_TOOLS.get(exec.name) === true;
        for (const candidate of paths) {
          if (pathDenied(candidate, cwd, readRoots, readWriteTails)) {
            return { kind: "deny", reason: DENY_REASON };
          }
          if (!mayRead && pathDenied(candidate, cwd, writeRoots, [])) {
            return { kind: "deny", reason: DENY_REASON };
          }
        }
      }
      if (SEARCH_TOOLS.has(exec?.name)) {
        for (const candidate of paths) {
          if (pathDenied(candidate, cwd, readRoots, readWriteTails)) {
            return { kind: "deny", reason: DENY_REASON };
          }
        }
      }
      if (SHELL_TOOLS.has(exec?.name)) {
        // Collapse `.` and duplicate separators first: `..\userdata\\secrets`
        // reaches the same folder as `..\userdata\secrets`.
        const command = norm(commandText(args))
          .replace(/\/+\.\//g, "/")
          .replace(/\/{2,}/g, "/");
        if (command.length > 0 && commandForms.some((form) => command.includes(form))) {
          return { kind: "deny", reason: DENY_REASON };
        }
        for (const candidate of shellWorkdirArguments(args)) {
          if (insideProtectedParent(candidate, cwd)) {
            return { kind: "deny", reason: DENY_REASON };
          }
        }
      }
      if (PTC_TOOLS.has(exec?.name)) {
        // Code mode: the program text is where the shell rule's spellings now
        // appear, because a `run_code` call can read and write files directly.
        const code = programText(args);
        const folded = norm(code)
          .replace(/\/+\.\//g, "/")
          .replace(/\/{2,}/g, "/");
        if (folded.length > 0 && commandForms.some((form) => folded.includes(form))) {
          return { kind: "deny", reason: DENY_REASON };
        }
        // Resolve the literal path strings against the session cwd: a bare
        // `secrets\x` from a data-root cwd never matches a command form.
        for (const literal of literalStrings(code)) {
          if (!/[\\/]/.test(literal)) continue;
          if (pathDenied(literal, cwd, readRoots, readWriteTails)) {
            return { kind: "deny", reason: DENY_REASON };
          }
        }
      }
      if (WORKING_DIRECTORY_TOOLS.has(exec?.name)) {
        // The launch patch disables this tool in every mode; the branch stays
        // so a runtime that still offers it cannot move the cwd into bot state.
        // dsh's tool takes the target as `cd`; `path` is kept for other shapes.
        const targets = typeof args.cd === "string" ? [...paths, args.cd] : paths;
        for (const candidate of targets) {
          if (insideProtectedParent(candidate, cwd)) {
            return { kind: "deny", reason: DENY_REASON };
          }
        }
      }
    } catch {
      // A guardrail that throws must never break the tool it guards.
    }
    return next();
  });
}
