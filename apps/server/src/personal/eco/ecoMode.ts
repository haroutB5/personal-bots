/**
 * Eco mode v1: the bot's own model plans a delegated task or routine run
 * without editing; when the task needs a lasting code change it calls
 * `eco_handoff(plan)`, and the same turn switches to a cheaper builder model
 * that implements and tests the plan.
 *
 * This module holds the pure parts, so the Claude adapter only wires them:
 * which turns are Eco turns, the save-time validation, the edit guard (a
 * `PreToolUse` hook, which runs in every permission mode), the handoff tool's
 * handler, the per-model usage split and the planner's instruction.
 *
 * @module personal/eco/ecoMode
 */
import {
  createSdkMcpServer,
  tool,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection, PersonalBot } from "@t3tools/contracts";
import { botEco } from "@t3tools/contracts";
import { z } from "zod";

import {
  canApplyClaudeSelectionLive,
  compileClaudeModelSelection,
} from "../../claudeModelOptions.ts";
import type { ClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";
import { isPersonalTaskMessageId } from "../personalThreadTitles.ts";

export const ECO_MCP_SERVER_NAME = "eco";
export const ECO_HANDOFF_TOOL_NAME = "eco_handoff";
/** The name Claude Code gives the tool. */
export const ECO_HANDOFF_TOOL = `mcp__${ECO_MCP_SERVER_NAME}__${ECO_HANDOFF_TOOL_NAME}`;
/** How long the handler waits for the model switch before it gives up. */
export const ECO_SWITCH_TIMEOUT_MS = 20_000;
/** eco_skipped: the thread's ordinary process runs background work, so it is not replaced. */
export const ECO_SKIPPED_BACKGROUND_WORK = "background_work";

// ---------------------------------------------------------------------------
// Settings

/**
 * Why a builder cannot be saved for a bot whose model is `planner`, or
 * undefined when it can. The switch happens inside a running Claude process,
 * so the builder must be on the same provider instance and switchable live:
 * the same thinking setting, and an effort when the planner has one.
 */
export function ecoBuilderProblem(
  planner: ModelSelection,
  builder: ModelSelection,
  catalog?: ClaudeModelCatalog,
): string | undefined {
  if (builder.instanceId !== planner.instanceId) {
    return "The Eco builder must run on the bot's own provider.";
  }
  if (builder.model === planner.model) {
    return "The Eco builder must be a different model from the bot's own.";
  }
  const live = compileClaudeModelSelection(planner, catalog);
  const next = compileClaudeModelSelection(builder, catalog);
  if (!canApplyClaudeSelectionLive(live, next)) {
    return "The Eco builder needs the same thinking setting as the bot's model, and an effort when the bot's model has one.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Which turns are Eco turns

export interface EcoTurnModels {
  readonly planner: ModelSelection;
  readonly builder: ModelSelection;
}

/**
 * The planner and builder for a turn, or undefined when the turn is not an
 * Eco turn. Only a delegated task, a steer into one, or a routine run (their
 * messages carry the task prefix) of an Eco bot on its own model; never a chat
 * the owner types into, a group round, or a bot on its usage-limit fallback.
 * The caller (the Claude adapter) is the Claude-only part.
 */
export function ecoTurnModels(input: {
  readonly bot: Pick<PersonalBot, "modelSelection" | "eco" | "fallbackActive">;
  readonly messageId: string;
  readonly modelSelection: ModelSelection;
}): EcoTurnModels | undefined {
  const eco = botEco(input.bot);
  if (!eco.enabled) return undefined;
  if (!isPersonalTaskMessageId(input.messageId)) return undefined;
  if (input.bot.fallbackActive !== undefined) return undefined;
  const own = input.bot.modelSelection;
  if (
    input.modelSelection.instanceId !== own.instanceId ||
    input.modelSelection.model !== own.model
  ) {
    return undefined;
  }
  if (eco.modelSelection.instanceId !== input.modelSelection.instanceId) return undefined;
  if (eco.modelSelection.model === input.modelSelection.model) return undefined;
  return { planner: input.modelSelection, builder: eco.modelSelection };
}

// ---------------------------------------------------------------------------
// The planner's instruction

export const ECO_TURN_INSTRUCTIONS = `<eco_mode>
This is an Eco turn and you are the planner. Investigate without editing: file edits, file-writing shell commands and git writes are blocked until you hand off. Keep the investigation short.
If, and only if, the task needs a lasting code change, call the ${ECO_HANDOFF_TOOL_NAME} tool once with a markdown plan in six parts: Goal, Scope, Where to change, Approach, Tests, Risks. A cheaper builder model then takes over this same turn to implement and test it, so write the plan for a reader who has not seen your investigation.
Before you hand off, check that every file, function, option, flag and command your plan names really exists, by reading the code or running it (for example its --help), not by assuming it from the task's wording. The task itself can be wrong about what exists. List anything you could not confirm under Risks, saying it is unconfirmed, and never present it as fact.
Otherwise, do or answer the task yourself without handing off.
</eco_mode>`;

export const withEcoInstructions = (text: string): string => `${ECO_TURN_INSTRUCTIONS}\n\n${text}`;

// ---------------------------------------------------------------------------
// Turn state

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export interface EcoCall {
  readonly id: string;
  readonly model: string;
  readonly side: "planner" | "builder";
}

export interface EcoTurnState {
  readonly runId: string;
  readonly threadId: string;
  readonly planner: ModelSelection;
  readonly builder: ModelSelection;
  readonly plannerApiModel: string;
  readonly builderApiModel: string;
  readonly startedAt: Date;
  handingOff: boolean;
  handedOff: boolean;
  handedOffAt: Date | undefined;
  plan: string | undefined;
  handoffError: string | undefined;
  /** Root assistant calls in order, by message id; the side is fixed when first seen. */
  readonly calls: Map<string, EcoCall>;
  /**
   * Each API call's own usage by message id (root and subagent calls alike),
   * so the turn is priced call by call with 5-minute and 1-hour cache writes
   * at their own rates. The SDK's summed `modelUsage` merges the two.
   */
  readonly usage: Map<string, EcoCallUsage>;
  /** The message in flight on each stream ("root" or a subagent's tool use id). */
  readonly streams: Map<string, { readonly id: string; readonly model: string }>;
}

export function makeEcoTurnState(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly models: EcoTurnModels;
  readonly plannerApiModel: string;
  readonly builderApiModel: string;
  readonly startedAt: Date;
}): EcoTurnState {
  return {
    runId: input.runId,
    threadId: input.threadId,
    planner: input.models.planner,
    builder: input.models.builder,
    plannerApiModel: input.plannerApiModel,
    builderApiModel: input.builderApiModel,
    startedAt: input.startedAt,
    handingOff: false,
    handedOff: false,
    handedOffAt: undefined,
    plan: undefined,
    handoffError: undefined,
    calls: new Map(),
    usage: new Map(),
    streams: new Map(),
  };
}

/** Notes one root assistant API call (a message id) and the model that answered it. */
export function noteEcoCall(turn: EcoTurnState, id: string, model: string): void {
  if (turn.calls.has(id) || model.length === 0 || model === "<synthetic>") return;
  turn.calls.set(id, { id, model, side: turn.handedOff ? "builder" : "planner" });
}

/** One API call's usage, as its assistant message reports it. */
export interface EcoCallUsage {
  readonly id: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
}

/**
 * Reads an assistant message's API `usage`. Without the `cache_creation`
 * breakdown every write counts as a 5-minute one, as the API bills it.
 */
export function ecoCallUsage(id: string, model: string, usage: unknown): EcoCallUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const fields = usage as Record<string, unknown>;
  const breakdown =
    typeof fields.cache_creation === "object" && fields.cache_creation !== null
      ? (fields.cache_creation as Record<string, unknown>)
      : undefined;
  const written = count(fields.cache_creation_input_tokens);
  const oneHour = breakdown === undefined ? 0 : count(breakdown.ephemeral_1h_input_tokens);
  const fiveMinutes =
    breakdown === undefined
      ? written
      : Math.max(count(breakdown.ephemeral_5m_input_tokens), written - oneHour);
  return {
    id,
    model,
    inputTokens: count(fields.input_tokens),
    outputTokens: count(fields.output_tokens),
    cacheReadTokens: count(fields.cache_read_input_tokens),
    cacheWrite5mTokens: fiveMinutes,
    cacheWrite1hTokens: oneHour,
  };
}

/**
 * Notes one API call's usage. Claude Code sends a message once per content
 * block, all under one id, so each count keeps the largest value seen.
 */
export function noteEcoUsage(turn: EcoTurnState, id: string, model: string, usage: unknown): void {
  if (id.length === 0 || model.length === 0 || model === "<synthetic>") return;
  const next = ecoCallUsage(id, model, usage);
  if (next === undefined) return;
  const was = turn.usage.get(id);
  turn.usage.set(
    id,
    was === undefined
      ? next
      : {
          id,
          model,
          inputTokens: Math.max(was.inputTokens, next.inputTokens),
          outputTokens: Math.max(was.outputTokens, next.outputTokens),
          cacheReadTokens: Math.max(was.cacheReadTokens, next.cacheReadTokens),
          cacheWrite5mTokens: Math.max(was.cacheWrite5mTokens, next.cacheWrite5mTokens),
          cacheWrite1hTokens: Math.max(was.cacheWrite1hTokens, next.cacheWrite1hTokens),
        },
  );
}

/**
 * Notes a streamed API call's usage. The assistant snapshots carry the usage
 * of `message_start`, whose output count is a few tokens; the final, cumulative
 * output count arrives only in `message_delta`, which has no message id, so the
 * id and model of the stream's last `message_start` are kept per stream (the
 * root, or a subagent's tool use id).
 */
export function noteEcoStreamEvent(turn: EcoTurnState, stream: string, event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const fields = event as Record<string, unknown>;
  if (fields.type === "message_start") {
    const message = fields.message as Record<string, unknown> | undefined;
    const id = typeof message?.id === "string" ? message.id : "";
    const model = typeof message?.model === "string" ? message.model : "";
    if (id.length === 0) return;
    turn.streams.set(stream, { id, model });
    noteEcoUsage(turn, id, model, message?.usage);
  } else if (fields.type === "message_delta") {
    const current = turn.streams.get(stream);
    const usage = fields.usage as Record<string, unknown> | undefined;
    if (current === undefined || usage === undefined) return;
    // Only the output count: the delta repeats the cache writes without the
    // 5m/1h breakdown, which would count 1-hour writes again as 5-minute ones.
    noteEcoUsage(turn, current.id, current.model, { output_tokens: usage.output_tokens });
  }
}

// ---------------------------------------------------------------------------
// The edit guard

/** Claude Code's file-editing tools. */
export const ECO_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
]);

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

/**
 * Whether `git branch` / `git tag` arguments change refs: a write flag, or a
 * ref name outside a listing (`git branch new`, `git tag v1`). `--sort=`,
 * `--format=`, `-v`, `-n3` and other display flags only list.
 */
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
/** `bash -c '...'`, `sh -lc "..."`: the script runs as a command of its own. */
const SHELL_C = new RegExp(`${COMMAND_START}${SHELLS}\\s+(?:-\\w+\\s+)*-\\w*c\\s+${QUOTED}`, "g");
/** `eval '...'` or `eval rm x`. */
const EVAL = new RegExp(`${COMMAND_START}eval\\s+(?:${QUOTED}|([^;&|\\n]+))`, "g");
/** `python -c '...'`, `node -e "..."`, `ruby -e`, `perl -e`. */
const INLINE_SCRIPT = new RegExp(
  `${COMMAND_START}${INTERPRETERS}\\s+(?:-[\\w-]+\\s+)*?(?:-c|-e|--eval|-p|--print)\\s+${QUOTED}`,
  "g",
);

/**
 * Splits out heredoc bodies: they are data, so a `>` inside one is not a
 * redirect. A body fed to a shell or an interpreter is returned with what reads it.
 */
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
      index += 1; // the delimiter line
      bodies.push({ reader: line, body: body.join("\n") });
    }
  }
  return { rest: kept.join("\n"), bodies };
}

/**
 * Whether a shell command writes files: a redirect into a file (not /tmp or
 * /dev/null), `tee`, `sed -i`, file commands (rm, mv, cp, mkdir, touch ...),
 * git writes, a package install, a download into a file, a formatter that
 * writes, or a script (`bash -c`, `eval`, `python -c`, `node -e`, a heredoc
 * fed to one) that does. A best-effort hint for the planner, not a sandbox.
 */
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

export const ECO_EDIT_DENIED_REASON = `Eco mode: you are the planner, so edits are blocked. Finish investigating, then call ${ECO_HANDOFF_TOOL_NAME} with your plan if the task needs a lasting code change.`;

/** The reason an Eco turn refuses this tool call, or undefined to let it run. */
export function ecoToolDenial(
  turn: EcoTurnState | null,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  if (turn === null || turn.handedOff) return undefined;
  if (ECO_EDIT_TOOLS.has(toolName)) return ECO_EDIT_DENIED_REASON;
  if (toolName === "Bash") {
    const command =
      typeof toolInput === "object" && toolInput !== null
        ? Reflect.get(toolInput, "command")
        : undefined;
    if (typeof command === "string" && bashCommandWrites(command)) return ECO_EDIT_DENIED_REASON;
  }
  return undefined;
}

/** The `PreToolUse` hook for a process that serves Eco turns. */
export function makeEcoPreToolUseHook(currentTurn: () => EcoTurnState | null): HookCallback {
  return (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return Promise.resolve({});
    const reason = ecoToolDenial(currentTurn(), hookInput.tool_name, hookInput.tool_input);
    if (reason === undefined) return Promise.resolve({});
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });
  };
}

// ---------------------------------------------------------------------------
// The handoff tool

export interface EcoToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

export const ECO_HANDOFF_SUCCESS_TEXT =
  "Implement this plan now; you are the builder. The plan is a guide, not the task: if the code contradicts it, or a file, function, option or flag it relies on does not exist, do not follow it blindly. Do what the task actually asks, and say in your final reply where you departed from the plan and why.";

const toolError = (text: string): EcoToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * The `eco_handoff` handler. It switches the running process to the builder
 * before it returns, so the very next API call of this turn is the builder's
 * (switching after the handler returns is one call late). Edits unlock only
 * once the switch has landed: a parallel Edit in the same message stays
 * denied. On a failed switch the turn stays on the planner with edits blocked;
 * `switchToBuilder` is responsible for putting the planner back.
 */
export async function runEcoHandoff(input: {
  readonly turn: EcoTurnState | null;
  readonly plan: string;
  readonly switchToBuilder: (turn: EcoTurnState) => Promise<void>;
  readonly onHandedOff?: (turn: EcoTurnState) => void;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}): Promise<EcoToolResult> {
  const turn = input.turn;
  if (turn === null) {
    return toolError("Eco handoff is only available on an Eco turn. Carry on without it.");
  }
  if (turn.handedOff || turn.handingOff) {
    return toolError("This turn has already handed off; only one handoff per turn.");
  }
  const plan = input.plan.trim();
  if (plan.length === 0) {
    return toolError("The plan is empty. Call eco_handoff with the six-part markdown plan.");
  }
  turn.handingOff = true;
  try {
    await withTimeout(input.switchToBuilder(turn), input.timeoutMs ?? ECO_SWITCH_TIMEOUT_MS);
  } catch (cause) {
    turn.handingOff = false;
    const detail = cause instanceof Error ? cause.message : String(cause);
    turn.handoffError = detail.slice(0, 500);
    return toolError(
      `The switch to the builder failed (${turn.handoffError}). You are still the planner and edits stay blocked. Report your plan in your reply instead of implementing it.`,
    );
  }
  turn.plan = plan;
  turn.handedOff = true;
  turn.handedOffAt = (input.now ?? (() => new Date()))();
  turn.handingOff = false;
  input.onHandedOff?.(turn);
  return { content: [{ type: "text", text: ECO_HANDOFF_SUCCESS_TEXT }] };
}

const ecoHandoffHandlers = new WeakMap<object, (plan: string) => Promise<EcoToolResult>>();

/** The eco_handoff handler behind a server from `makeEcoMcpServer` (for tests, without an MCP client). */
export const ecoHandoffHandlerOf = (
  server: unknown,
): ((plan: string) => Promise<EcoToolResult>) | undefined =>
  typeof server === "object" && server !== null ? ecoHandoffHandlers.get(server) : undefined;

/** The in-process MCP server that carries `eco_handoff`, loaded up front (not behind ToolSearch). */
export function makeEcoMcpServer(
  handle: (plan: string) => Promise<EcoToolResult>,
): McpSdkServerConfigWithInstance {
  const server = createSdkMcpServer({
    name: ECO_MCP_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    timeout: ECO_SWITCH_TIMEOUT_MS + 15_000,
    tools: [
      tool(
        ECO_HANDOFF_TOOL_NAME,
        "Eco mode: hand your plan to the builder model, which implements and tests it in this same turn. Call it once, only when the task needs a lasting code change. The plan is markdown in six parts: Goal, Scope, Where to change, Approach, Tests, Risks.",
        { plan: z.string().describe("The six-part markdown plan.") },
        async ({ plan }) => {
          const result = await handle(plan);
          return {
            content: result.content.map((part) => ({ type: part.type, text: part.text })),
            ...(result.isError === true ? { isError: true } : {}),
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });
  ecoHandoffHandlers.set(server, handle);
  return server;
}

/** The plan as the chat shows it: the handoff marker, then the plan. */
export const ecoPlanMarkdown = (builderLabel: string, plan: string): string =>
  `**Handed off to ${builderLabel}**\n\n${plan}`;

// ---------------------------------------------------------------------------
// Usage

export interface EcoModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly sdkCostUsd: number;
}

/** Per model, from the SDK result's `modelUsage`, with cache reads and writes kept apart. */
export type EcoModelLedger = ReadonlyMap<string, EcoModelUsage>;

export function ecoModelLedger(modelUsage: unknown): EcoModelLedger {
  const ledger = new Map<string, EcoModelUsage>();
  if (typeof modelUsage !== "object" || modelUsage === null) return ledger;
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const fields = (entry ?? {}) as Record<string, unknown>;
    ledger.set(model, {
      inputTokens: count(fields.inputTokens),
      outputTokens: count(fields.outputTokens),
      cacheReadTokens: count(fields.cacheReadInputTokens),
      cacheWriteTokens: count(fields.cacheCreationInputTokens),
      sdkCostUsd: count(fields.costUSD),
    });
  }
  return ledger;
}

export const EMPTY_ECO_USAGE: EcoModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  sdkCostUsd: 0,
};

/** Growth per model from `before` to `after`; a counter that went back counts from zero (a new process). */
export function ecoLedgerDelta(before: EcoModelLedger, after: EcoModelLedger): EcoModelLedger {
  const delta = new Map<string, EcoModelUsage>();
  for (const [model, now] of after) {
    const was = before.get(model) ?? EMPTY_ECO_USAGE;
    const wentBack =
      now.inputTokens < was.inputTokens ||
      now.outputTokens < was.outputTokens ||
      now.cacheReadTokens < was.cacheReadTokens ||
      now.cacheWriteTokens < was.cacheWriteTokens;
    const base = wentBack ? EMPTY_ECO_USAGE : was;
    const grown = {
      inputTokens: now.inputTokens - base.inputTokens,
      outputTokens: now.outputTokens - base.outputTokens,
      cacheReadTokens: now.cacheReadTokens - base.cacheReadTokens,
      cacheWriteTokens: now.cacheWriteTokens - base.cacheWriteTokens,
      sdkCostUsd: Math.max(0, now.sdkCostUsd - base.sdkCostUsd),
    };
    if (
      grown.inputTokens + grown.outputTokens + grown.cacheReadTokens + grown.cacheWriteTokens >
      0
    ) {
      delta.set(model, grown);
    }
  }
  return delta;
}

/** A ledger key names `apiModel` when it is the id itself or the id without its `[1m]`-style suffix. */
export const ledgerKeyMatches = (key: string, apiModel: string): boolean => {
  const bare = (model: string) => model.replace(/\[[^\]]*\]$/, "");
  return key === apiModel || bare(key) === bare(apiModel);
};

export interface EcoUsageSplit {
  readonly planner: EcoModelUsage;
  readonly builder: EcoModelUsage;
  /** Models that are neither, such as Claude Code's background Haiku calls. */
  readonly other: ReadonlyArray<{ readonly model: string; readonly usage: EcoModelUsage }>;
}

/**
 * The turn's usage split into the planner's and the builder's: by model, since
 * the two are different models (save-time validation makes sure of that).
 */
export function ecoUsageSplit(
  turnDelta: EcoModelLedger,
  plannerApiModel: string,
  builderApiModel: string,
): EcoUsageSplit {
  let planner = EMPTY_ECO_USAGE;
  let builder = EMPTY_ECO_USAGE;
  const other: Array<{ readonly model: string; readonly usage: EcoModelUsage }> = [];
  const add = (left: EcoModelUsage, right: EcoModelUsage): EcoModelUsage => ({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    sdkCostUsd: left.sdkCostUsd + right.sdkCostUsd,
  });
  for (const [model, usage] of turnDelta) {
    if (ledgerKeyMatches(model, plannerApiModel)) planner = add(planner, usage);
    else if (ledgerKeyMatches(model, builderApiModel)) builder = add(builder, usage);
    else other.push({ model, usage });
  }
  return { planner, builder, other };
}
