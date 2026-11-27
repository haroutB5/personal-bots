/**
 * Shared Eco mode constants, prompts, shell-write detection, and ACP permission
 * guard used by both Claude and Antigravity/ACP Eco turns.
 *
 * @module provider-core/server/ecoGuard
 */

export const ECO_HANDOFF_TOOL_NAME = "eco_handoff";
/** How long the handler waits for the model switch before it gives up. */
export const ECO_SWITCH_TIMEOUT_MS = 20_000;
/** eco_skipped: the thread's ordinary process runs background work, so it is not replaced. */
export const ECO_SKIPPED_BACKGROUND_WORK = "background_work";
/** eco_skipped: after a main-model change, the saved builder is on another provider. */
export const ECO_SKIPPED_BUILDER_OTHER_PROVIDER = "builder_other_provider";
/** eco_skipped: after a main-model change, the saved builder is the bot's own model. */
export const ECO_SKIPPED_BUILDER_SAME_MODEL = "builder_same_model";
/** eco_skipped: the saved builder cannot be switched to live (thinking or effort differ). */
export const ECO_SKIPPED_BUILDER_NOT_SWITCHABLE = "builder_not_switchable";

/** The plan as the chat shows it: the handoff marker, then the plan. */
export const ecoPlanMarkdown = (builderLabel: string, plan: string): string =>
  `**Handed off to ${builderLabel}**\n\n${plan}`;

export const ECO_ACP_HANDOFF_PLANNER_ACK =
  "Plan accepted for handoff to the builder model. End your response now without making any further tool calls or edits: once your response finishes, the builder model will take over this same session to implement and test your plan.";

const ECO_ACP_TURN_INSTRUCTIONS = `<eco_mode>
This is an Eco turn and you are the planner. Investigate without editing: file edits, file-writing shell commands and git writes are blocked until you hand off. Keep the investigation short.
If, and only if, the task needs a lasting code change, call the ${ECO_HANDOFF_TOOL_NAME} tool once with a markdown plan in six parts: Goal, Scope, Where to change, Approach, Tests, Risks, and then end your response immediately without making further tool calls. A cheaper builder model then takes over this same session to implement and test it, so write the plan for a reader who has not seen your investigation.
Before you hand off, check that every file, function, option, flag and command your plan names really exists, by reading the code or running it (for example its --help), not by assuming it from the task's wording. The task itself can be wrong about what exists. List anything you could not confirm under Risks, saying it is unconfirmed, and never present it as fact.
Otherwise, do or answer the task yourself without handing off.
</eco_mode>`;

export const withAcpEcoInstructions = (text: string): string =>
  `${ECO_ACP_TURN_INSTRUCTIONS}\n\n${text}`;

export const ecoAcpBuilderPrompt = (plan: string): string =>
  `<eco_builder>
Implement this plan now; you are the builder. The plan is a guide, not the task: if the code contradicts it, or a file, function, option or flag it relies on does not exist, do not follow it blindly. Do what the task actually asks, and say in your final reply where you departed from the plan and why.
</eco_builder>

${plan}`;

const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "ln",
  "tee",
  "truncate",
  "dd",
  "install",
  "rsync",
  "unlink",
  "patch",
  "chmod",
  "chown",
  "shred",
]);

const GIT_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "worktree",
  "branch",
  "update-ref",
  "notes",
]);

/** `git branch` flags that change branches; anything else with no branch name lists. */
const GIT_BRANCH_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
  "-t",
  "--track",
  "--no-track",
]);
/** `git branch` / `git tag` flags that select a listing (some take a value). */
const GIT_LIST_FLAGS: ReadonlySet<string> = new Set([
  "-l",
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--show-current",
]);
/** `git tag` flags that create, sign or delete a tag. */
const GIT_TAG_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "-a",
  "--annotate",
  "-s",
  "--sign",
  "-u",
  "--local-user",
  "-d",
  "--delete",
  "-f",
  "--force",
  "-m",
  "--message",
  "-F",
  "--file",
]);

function gitRefCommandWrites(
  args: ReadonlyArray<string>,
  writeFlags: ReadonlySet<string>,
): boolean {
  const flagName = (arg: string) => arg.split("=")[0]!;
  if (args.some((arg) => arg.startsWith("-") && writeFlags.has(flagName(arg)))) return true;
  if (args.some((arg) => GIT_LIST_FLAGS.has(flagName(arg)))) return false;
  return args.some((arg) => !arg.startsWith("-"));
}

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "vp",
  "pip",
  "pip3",
]);
const PACKAGE_WRITE_VERBS: ReadonlySet<string> = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "upgrade",
]);

/** Words that run the next word as the command. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "exec",
  "time",
  "nice",
  "nohup",
  "xargs",
  "timeout",
  "builtin",
  "npx",
  "pnpx",
  "bunx",
]);

/** Replaces quoted text with a placeholder, so `echo "a > b"` is not a redirect. */
function maskQuotes(command: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote === null) {
      if (ch === "\\" && i + 1 < command.length) {
        out += "__";
        i += 1;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        out += "Q";
      } else {
        out += ch;
      }
    } else if (ch === quote) {
      quote = null;
    } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
      i += 1;
    }
  }
  return out;
}

/** True when the (quote-masked) command redirects output into a file. */
function hasFileRedirect(masked: string): boolean {
  const redirect = /(\d*|&)>>?\|?\s*([^\s;&|<>()]*)/g;
  for (const match of masked.matchAll(redirect)) {
    const start = match.index ?? 0;
    // `=>` and `->` (arrows in code snippets) are not redirects.
    const before = start > 0 ? masked[start - 1] : "";
    if (match[1] === "" && (before === "=" || before === "-")) continue;
    const target = match[2] ?? "";
    if (target.startsWith("&")) continue; // 2>&1, >&2
    if (isScratchTarget(target)) continue;
    // `>&2` is captured with an empty target followed by &; anything else writes.
    if (target === "" && masked[start + match[0].length] === "&") continue;
    return true;
  }
  return false;
}

function segmentWrites(words: ReadonlyArray<string>): boolean {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || COMMAND_PREFIXES.has(word)) {
      index += 1;
      continue;
    }
    // Flags of a prefix (`timeout 5`, `nice -n 5`, `env -i`) are skipped too.
    if (index > 0 && COMMAND_PREFIXES.has(words[index - 1]!) && /^-|^\d/.test(word)) {
      index += 1;
      continue;
    }
    break;
  }
  const name = (words[index] ?? "").replace(/^.*\//, "");
  const args = words.slice(index + 1);
  if (name.length === 0) return false;
  if (name === "tee") return args.some((arg) => !arg.startsWith("-") && !isScratchTarget(arg));
  if (WRITE_COMMANDS.has(name)) return true;
  if (name === "curl") return curlWrites(args);
  if (name === "wget") {
    return !args.some(
      (arg, i) =>
        arg === "--spider" ||
        arg === "--output-document=-" ||
        /^-[A-Za-z]*O-$/.test(arg) ||
        (/^-[A-Za-z]*O$/.test(arg) && args[i + 1] === "-"),
    );
  }
  if (name === "prettier") return args.some((arg) => arg === "--write" || arg === "-w");
  if (name === "eslint" || name === "oxlint") return args.some((arg) => arg.startsWith("--fix"));
  if (name === "biome") {
    return args.some((arg) => arg === "--write" || arg === "--apply" || arg === "--fix");
  }
  if (name === "oxfmt") return !args.includes("--check");
  if (name === "sed" || name === "perl") {
    return args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"));
  }
  if (name === "find") {
    return args.some(
      (arg, i) =>
        arg === "-delete" ||
        ((arg === "-exec" || arg === "-execdir" || arg === "-ok") &&
          segmentWrites(args.slice(i + 1))),
    );
  }
  if (name === "git") {
    let i = 0;
    // Global options before the subcommand: -C <dir>, -c <k=v>, --no-pager ...
    while (i < args.length && args[i]!.startsWith("-")) {
      i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
    }
    const sub = args[i];
    if (sub === undefined || !GIT_WRITE_SUBCOMMANDS.has(sub)) return false;
    if (sub === "branch") return gitRefCommandWrites(args.slice(i + 1), GIT_BRANCH_WRITE_FLAGS);
    if (sub === "tag") return gitRefCommandWrites(args.slice(i + 1), GIT_TAG_WRITE_FLAGS);
    if (sub === "stash") {
      const action = args[i + 1];
      return action !== "list" && action !== "show";
    }
    if (sub === "worktree") return args[i + 1] !== "list";
    if (sub === "notes") {
      const rest = args.slice(i + 1);
      return rest.length > 0 && !rest.every((arg) => arg === "-l" || arg === "--list");
    }
    return true;
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const verb = args.find((arg) => !arg.startsWith("-"));
    if (name === "vp" && verb === "fmt") return !args.includes("--check");
    return verb !== undefined && PACKAGE_WRITE_VERBS.has(verb);
  }
  return false;
}

/** /dev/null, the standard streams and /tmp: writing there changes no project file. */
function isScratchTarget(target: string): boolean {
  return (
    target === "/dev/null" ||
    target === "/dev/stdout" ||
    target === "/dev/stderr" ||
    target === "-" ||
    target === "/tmp" ||
    target.startsWith("/tmp/") ||
    target.startsWith("$TMPDIR") ||
    target.startsWith("${TMPDIR")
  );
}

/** `curl -o file`, `--output file`, `-O` / `--remote-name`: a download into a file. */
function curlWrites(args: ReadonlyArray<string>): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--remote-name" || arg === "--remote-name-all") return true;
    if (arg === "--output") {
      if (!isScratchTarget(args[i + 1] ?? "")) return true;
      continue;
    }
    if (arg.startsWith("--output=")) {
      if (!isScratchTarget(arg.slice("--output=".length))) return true;
      continue;
    }
    if (/^-[A-Za-z]+/.test(arg) && !arg.startsWith("--")) {
      const flags = arg.slice(1);
      if (flags.includes("O")) return true;
      const at = flags.indexOf("o");
      if (at === -1) continue;
      const target = at === flags.length - 1 ? (args[i + 1] ?? "") : flags.slice(at + 1);
      if (!isScratchTarget(target)) return true;
    }
  }
  return false;
}

/** Code (`python -c`, `node -e`, a heredoc fed to one) that writes, moves or deletes files. */
const SCRIPT_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]/,
  /\.(?:write_text|write_bytes|touch|unlink|rmdir|mkdir|rename)\s*\(/,
  /\b(?:os|shutil)\.(?:remove|unlink|rmdir|removedirs|rename|replace|makedirs|mkdir|rmtree|move|copy\w*|chmod|chown|truncate)\b/,
  /\b(?:writeFile|appendFile|unlink|rmSync|rmdirSync|mkdirSync|renameSync|copyFile|cpSync|truncate)\w*\s*\(/,
  /\bcreateWriteStream\b|\bBun\.write\b|\bDeno\.(?:write|remove|rename|mkdir)\w*/,
  /\bFile\.(?:write|delete|rename)\b|\bFileUtils\./,
];
const scriptWrites = (code: string): boolean =>
  SCRIPT_WRITE_PATTERNS.some((pattern) => pattern.test(code));

const SHELLS = "(?:bash|sh|zsh|dash|ksh)";
const INTERPRETERS = "(?:python[0-9.]*|node|deno|bun|ruby|perl)";
const QUOTED = `(?:'([^']*)'|"((?:\\\\.|[^"\\\\])*)")`;
const COMMAND_START = "(?:^|[\\s;&|(`])(?:\\S*/)?";
const SHELL_C = new RegExp(`${COMMAND_START}${SHELLS}\\s+(?:-\\w+\\s+)*-\\w*c\\s+${QUOTED}`, "g");
const EVAL = new RegExp(`${COMMAND_START}eval\\s+(?:${QUOTED}|([^;&|\\n]+))`, "g");
const INLINE_SCRIPT = new RegExp(
  `${COMMAND_START}${INTERPRETERS}\\s+(?:-[\\w-]+\\s+)*?(?:-c|-e|--eval|-p|--print)\\s+${QUOTED}`,
  "g",
);

function splitHeredocs(command: string): {
  readonly rest: string;
  readonly bodies: ReadonlyArray<{ readonly reader: string; readonly body: string }>;
} {
  const lines = command.split("\n");
  const kept: Array<string> = [];
  const bodies: Array<{ reader: string; body: string }> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    kept.push(line);
    index += 1;
    const delimiters = [...line.matchAll(/<<(?!<)-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g)].map(
      (match) => match[2]!,
    );
    for (const delimiter of delimiters) {
      const body: Array<string> = [];
      while (index < lines.length && lines[index]!.trim() !== delimiter) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      bodies.push({ reader: line, body: body.join("\n") });
    }
  }
  return { rest: kept.join("\n"), bodies };
}

/** Whether a shell command writes project files (best-effort planner guard, not a sandbox). */
export function bashCommandWrites(command: string, depth = 0): boolean {
  if (depth > 4) return true;
  const { rest, bodies } = splitHeredocs(command);
  for (const { reader, body } of bodies) {
    const fedTo = maskQuotes(reader);
    if (new RegExp(`${COMMAND_START}${SHELLS}\\b`).test(fedTo)) {
      if (bashCommandWrites(body, depth + 1)) return true;
    } else if (new RegExp(`${COMMAND_START}${INTERPRETERS}\\b`).test(fedTo) && scriptWrites(body)) {
      return true;
    }
  }
  for (const match of rest.matchAll(SHELL_C)) {
    if (bashCommandWrites(match[1] ?? match[2] ?? "", depth + 1)) return true;
  }
  for (const match of rest.matchAll(EVAL)) {
    if (bashCommandWrites(match[1] ?? match[2] ?? match[3] ?? "", depth + 1)) return true;
  }
  for (const match of rest.matchAll(INLINE_SCRIPT)) {
    if (scriptWrites(match[1] ?? match[2] ?? "")) return true;
  }
  // `[[ a > b ]]` and `(( a > b ))` compare; they do not redirect.
  const masked = maskQuotes(rest)
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\(\([^)]*\)\)/g, " ");
  if (hasFileRedirect(masked)) return true;
  // Command substitutions run commands of their own.
  const flattened = masked.replace(/\$\(|`|\(|\)/g, " ; ");
  const segments = flattened.split(/&&|\|\||[;|&\n]/);
  return segments.some((segment) => segmentWrites(segment.trim().split(/\s+/).filter(Boolean)));
}

const ACP_MUTATION_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

const ACP_FILE_MUTATION_TITLE =
  /\b(?:edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|create_file|delete_file|remove_file|move_file|rename_file|apply_patch|notebook_edit|multiedit)\b/i;

function extractShellCommand(rawInput: unknown): string | undefined {
  if (typeof rawInput === "string") return rawInput;
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return undefined;
  }
  const record = rawInput as Record<string, unknown>;
  for (const key of ["CommandLine", "command", "cmd"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * Whether an ACP permission request must be denied while the Eco planner is
 * active: blocks edit/delete/move kinds, file-mutation titles, and write shell commands.
 */
export function ecoAcpPermissionDenied(request: {
  readonly toolCall: {
    readonly kind?: string | null;
    readonly title?: string | null;
    readonly rawInput?: unknown;
  };
}): boolean {
  const { kind, title, rawInput } = request.toolCall;
  if (kind != null && ACP_MUTATION_KINDS.has(kind)) return true;
  if (typeof title === "string" && ACP_FILE_MUTATION_TITLE.test(title)) return true;
  const command = extractShellCommand(rawInput);
  if (command !== undefined && bashCommandWrites(command)) return true;
  if (
    kind === "execute" &&
    command === undefined &&
    typeof title === "string" &&
    bashCommandWrites(title.replace(/^(?:run|execute)\s+/i, ""))
  ) {
    return true;
  }
  return false;
}
