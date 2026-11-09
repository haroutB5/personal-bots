/** Pure dsh launch support: patch rows, persona, environment, cursor, effort,
 * mode, and reply strippers. Five patch rows are privacy-critical in every
 * launch, or dsh uploads the session log, inventory or a paid web search.
 * @module provider-deepseek/server/dshSupport */
import { DEEPSEEK_AGENT_MODE_OPTION_ID, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DEEPSEEK_FLASH_MODEL } from "./catalog.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV, isLeakedSecretName } from "./environment.ts";
import { dedupeEnvironmentNames } from "./environmentNames.ts";
import {
  DEEPSEEK_DEFAULT_AGENT_MODE,
  DEEPSEEK_DSH_AGENT_MODES,
  type DeepSeekDshAgentMode,
} from "./status.ts";

export const DSH_AGENT_MODES = DEEPSEEK_DSH_AGENT_MODES;
export type DshAgentMode = DeepSeekDshAgentMode;
export const DSH_DEFAULT_AGENT_MODE: DshAgentMode = DEEPSEEK_DEFAULT_AGENT_MODE;
export { DEEPSEEK_AGENT_MODE_OPTION_ID };
export { DSH_PINNED_VERSION } from "./engine.ts";

/** The key dsh reads, and the only credential its child environment carries. */
export const DEEPSEEK_DSH_API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * Rows the patch must always carry. Named here so the patch builder and the
 * unit test that guards them cannot drift apart: the first stops dsh
 * uploading the canonical session log with every model request, the second
 * its OTEL session telemetry, the third its paid `web_search`.
 */
export const DSH_SESSION_LOG_ROW_ID = "session-log-deepseek";
export const DSH_TELEMETRY_ROW_ID = "session-telemetry-otel";
export const DSH_WEB_SEARCH_ROW_ID = "web-search-deepseek";
/** dsh's DeepSeek web fetch/search API routes; disabled so only http fetch stays. */
export const DSH_WEB_DEEPSEEK_API_ROW_ID = "web-deepseek-api";
/** The plugin inventory dsh otherwise sends with every request. */
export const DSH_PLUGIN_INVENTORY_ROW_ID = "plugin-package-inventory-deepseek";
/** The cwd-changing tool dsh 0.2.1 adds; off in every mode. */
export const DSH_WORKING_DIRECTORY_TOOL_ROW_ID = "tool-working-directory";

/** The bot-state deny plugin, installed beside the runtime pin. */
export const DSH_DENY_PLUGIN_FILE = "hbots-deny-plugin.mjs";
/** The row the deny plugin is loaded under. */
export const DSH_DENY_ROW_ID = "hbots-deny";

/** dsh sends the MCP credential as an HTTP header, so drop `T3_MCP_TOKEN`. */
const MCP_TOKEN_ENV_NAME = "T3_MCP_TOKEN";

/**
 * Environment names that must never reach a dsh child: every `ANTHROPIC_*`
 * (the credential alias, endpoint and model pins belong to the Claude engine),
 * the DeepSeek Claude-engine pins, and any ambient `DEEPSEEK_*` that could
 * shadow the instance's own key.
 */
function isClaudeEngineEnvName(name: string): boolean {
  return (
    name.startsWith("ANTHROPIC_") ||
    name.startsWith("CLAUDE_CODE_") ||
    name === "CLAUDE_CONFIG_DIR" ||
    name.startsWith("DEEPSEEK_") ||
    name === MCP_TOKEN_ENV_NAME
  );
}

/**
 * The dsh child environment: ambient secrets and Claude/DeepSeek pins removed,
 * `ANTHROPIC_AUTH_TOKEN` becomes the only `DEEPSEEK_API_KEY`, and telemetry is
 * off. The key never enters the patch, arguments or a log line.
 */
export const buildDshEnvironment = Effect.fn("buildDshEnvironment")(function* (input: {
  readonly instanceEnv: NodeJS.ProcessEnv;
  readonly runtimeMode: RuntimeMode;
  readonly dshHome: string;
}): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const path = yield* Path.Path;
  const stripped: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(input.instanceEnv)) {
    if (value === undefined) continue;
    if (isLeakedSecretName(name)) continue;
    if (isClaudeEngineEnvName(name)) continue;
    stripped[name] = value;
  }
  const next = dedupeEnvironmentNames(stripped);
  const token = input.instanceEnv[DEEPSEEK_AUTH_TOKEN_ENV]?.trim() ?? "";
  if (token.length > 0) {
    next[DEEPSEEK_DSH_API_KEY_ENV] = token;
  }
  next.DSH_HOME = input.dshHome;
  next.DSH_TELEMETRY_DISABLED = "1";
  next.DSH_TELEMETRY_MODE = "DISABLED";
  next.DSH_PERMISSION_MODE =
    input.runtimeMode === "full-access" ? "danger-full-access" : "workspace-write";
  // An empty agents home, so `~/.agents/skills` on this machine never leaks
  // into a bot's skill list.
  next.DSH_AGENTS_HOME = path.join(input.dshHome, "agents-home");
  return dedupeEnvironmentNames(next);
});

/**
 * dsh throws on an unknown `{{name}}` placeholder, so bot-authored braces are
 * broken with a zero-width space: invisible to the model, inert to dsh.
 */
export function escapeDshPersonaText(text: string): string {
  return text.replaceAll("{{", "{\u200b{");
}

/**
 * The bot-state deny plugin as one launch row. The caller computes the real
 * paths, so the plugin file itself ships static with the runtime pin and never
 * has to know a data root.
 */
export interface DshDenyPluginInput {
  /** `file:///…/hbots-deny-plugin.mjs`, the loader's own row-name syntax. */
  readonly pluginUrl: string;
  /** Paths denied for reading and writing (`<stateDir>/secrets`). */
  readonly denyReadWrite: ReadonlyArray<string>;
  /** Paths denied for writing only (the database, its sidecars, the harness home). */
  readonly denyWrite: ReadonlyArray<string>;
}

export interface DshLaunchPatchInput {
  readonly personaSuffix: string;
  readonly skillDirs: ReadonlyArray<string>;
  readonly mode: DshAgentMode;
  readonly deny?: DshDenyPluginInput | undefined;
}

const DSH_PERSONA_PREFIX = "You are a coding agent powered by the {{model}} model.";

/** Minimal mode's row list: everything but a shell and the bot's own tools. */
const MINIMAL_DISABLED_ROWS: ReadonlyArray<string> = [
  "tool-pwsh",
  "tool-bash",
  "tool-fs",
  "tool-fs-search",
  "tool-jobs",
  "tool-skill",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-workflow",
  "tool-goal",
  "tool-todo",
  "tool-web",
  "plan-mode",
];

/**
 * Rows that set the mode. `standard` adds nothing (dsh's own acp defaults),
 * `code` switches the tool surface to PTC (`run_code` plus a generated SDK),
 * and `minimal` keeps one persistent shell plus whatever MCP servers the
 * client mounted.
 */
function modeRows(mode: DshAgentMode): ReadonlyArray<Record<string, unknown>> {
  if (mode === "code") return [{ id: "tools", config: { mode: "ptc" } }];
  if (mode === "minimal") return MINIMAL_DISABLED_ROWS.map((id) => ({ id, disabled: true }));
  return [];
}

/** Minimal mode's own extra rows: one persistent shell, plus MCP tools. */
const MINIMAL_INSERTED_ROWS: ReadonlyArray<Record<string, unknown>> = [
  { id: "pty", name: "@deepseek-ai/dsh-terminal" },
  {
    id: "terminal-pwsh",
    name: "@deepseek-ai/dsh-terminal-bash",
    config: { shellDialect: "pwsh", timeoutMs: 300000 },
  },
  {
    id: "persistent-pwsh",
    name: "@deepseek-ai/dsh-tool-pwsh-persistent",
    config: { timeoutMs: 300000 },
  },
];

/**
 * Rows loaded from outside the profile. The deny plugin runs in every mode
 * (it hooks the shared tool scheduler, so PTC and subagents are covered too),
 * and one `insert` row holds it together with minimal mode's own additions.
 */
function insertedRows(input: DshLaunchPatchInput): ReadonlyArray<Record<string, unknown>> {
  return [
    ...(input.deny === undefined
      ? []
      : [
          {
            id: DSH_DENY_ROW_ID,
            name: input.deny.pluginUrl,
            config: {
              denyReadWrite: [...input.deny.denyReadWrite],
              denyWrite: [...input.deny.denyWrite],
            },
          },
        ]),
    ...(input.mode === "minimal" ? MINIMAL_INSERTED_ROWS : []),
  ];
}

/**
 * The launch overlay in row order. JSON is valid YAML, and the persona is
 * bot-authored text with quotes, colons, `#` and backslashes in it. Flash is
 * pinned twice so no alias can route a turn to Pro.
 */
export function buildDshLaunchPatch(input: DshLaunchPatchInput): Array<Record<string, unknown>> {
  const inserted = insertedRows(input);
  return [
    { id: "acp", config: { provider: "deepseek-official", model: DEEPSEEK_FLASH_MODEL } },
    {
      id: "agent-default-model",
      config: {
        provider: "deepseek-official",
        model: DEEPSEEK_FLASH_MODEL,
        reasoningEffort: "high",
      },
    },
    {
      id: "system-prompt",
      config: {
        personaPrefix: DSH_PERSONA_PREFIX,
        personaSuffix: escapeDshPersonaText(input.personaSuffix),
      },
    },
    {
      id: "skill-filesystem",
      config: {
        includeDefaultRoots: false,
        customSkillDirs: [...input.skillDirs],
      },
    },
    { id: DSH_TELEMETRY_ROW_ID, disabled: true },
    // Never ship without this row: dsh otherwise uploads the whole canonical
    // session log to DeepSeek inside every model request.
    { id: DSH_SESSION_LOG_ROW_ID, config: { enabled: false } },
    { id: DSH_WEB_SEARCH_ROW_ID, disabled: true },
    // The DeepSeek Search/Fetch API routes register with the same credential
    // even when the `web` row keeps http fetch; nothing in this profile uses
    // them, so the whole route is off.
    { id: DSH_WEB_DEEPSEEK_API_ROW_ID, disabled: true },
    // 0.2.1's cwd-changing tool is off in every mode: a cwd under the data
    // root made a relative `secrets/...` path resolve into the sealed store.
    // The `working-directory` service row stays, or every relative fs path
    // would break.
    { id: DSH_WORKING_DIRECTORY_TOOL_ROW_ID, disabled: true },
    // The inventory of every active plugin package, otherwise sent with each
    // request: no feature in this profile reads it.
    { id: DSH_PLUGIN_INVENTORY_ROW_ID, config: { enabled: false } },
    { id: "web", config: { fetchProvider: "http" } },
    { id: "tool-web", config: { search: false, fetch: true } },
    ...modeRows(input.mode),
    ...(inserted.length > 0 ? [{ insert: inserted }] : []),
  ];
}

/** The launch patch as the JSON text dsh reads. */
export function serializeDshLaunchPatch(input: DshLaunchPatchInput): string {
  return `${JSON.stringify(buildDshLaunchPatch(input), null, 2)}\n`;
}

export const DSH_RESUME_ENGINE = "dsh";

/** The chat's saved dsh session: `{engine:"dsh", resume, mode}`. */
export const DshResumeCursor = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Number),
  engine: Schema.Literal(DSH_RESUME_ENGINE),
  resume: Schema.NonEmptyString,
  mode: Schema.optional(Schema.Literals(["standard", "code", "minimal"])),
});
export type DshResumeCursor = typeof DshResumeCursor.Type;

const decodeDshResumeCursor = Schema.decodeUnknownOption(DshResumeCursor);

/**
 * The dsh state a cursor carries, or None for another engine's cursor.
 * A foreign cursor fails the first turn with the missing-conversation text,
 * so the server renews the session from the chat's text.
 */
export function parseDshResumeCursor(cursor: unknown): Option.Option<DshResumeCursor> {
  return decodeDshResumeCursor(cursor);
}

/** True for a cursor that names a dsh session. */
export function isDshResumeCursor(cursor: unknown): boolean {
  return Option.isSome(parseDshResumeCursor(cursor));
}

function decodeAgentMode(value: unknown): DshAgentMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return DSH_AGENT_MODES.some((mode) => mode.value === normalized)
    ? (normalized as DshAgentMode)
    : undefined;
}

/**
 * dsh's `reasoning_effort` values, and which hbots effort each one stands for.
 * dsh offers `off`, `low`, `high` and `max`; hbots efforts above high all
 * mean "think as long as you can", so they take `max`. Anything this map does
 * not name (hbots' own default) keeps dsh's `high`.
 */
const DSH_EFFORT_BY_HBOTS_EFFORT: Readonly<Record<string, string>> = {
  off: "off",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
  ultrathink: "max",
};

/** The model-selection option id every provider uses for reasoning effort. */
const EFFORT_OPTION_ID = "effort";

/** The `reasoning_effort` a turn should run at. */
export function resolveDshEffort(
  selection:
    | {
        readonly options?: ReadonlyArray<{
          readonly id: string;
          readonly value: string | boolean;
        }>;
      }
    | undefined,
): string {
  const raw = selection?.options?.find((option) => option.id === EFFORT_OPTION_ID)?.value;
  if (typeof raw !== "string") return "high";
  return DSH_EFFORT_BY_HBOTS_EFFORT[raw.trim().toLowerCase()] ?? "high";
}

/** The agent mode a model selection carries, or the default when it names none. */
export function dshAgentModeFromSelection(
  selection:
    | {
        readonly options?: ReadonlyArray<{
          readonly id: string;
          readonly value: string | boolean;
        }>;
      }
    | undefined,
): DshAgentMode {
  const value = selection?.options?.find(
    (option) => option.id === DEEPSEEK_AGENT_MODE_OPTION_ID,
  )?.value;
  return decodeAgentMode(value) ?? DSH_DEFAULT_AGENT_MODE;
}

/**
 * The agent mode a session is pinned to. A cursor that names one wins: a
 * resumed Standard session cannot run under the Code overlay (DeepSeek
 * refuses deferred tools), so a bot's current mode applies to new chats and
 * fresh sessions only.
 */
export function resolveDshSessionMode(input: {
  readonly cursor: unknown;
  readonly requested: unknown;
}): { readonly mode: DshAgentMode; readonly pinned: boolean } {
  const cursor = parseDshResumeCursor(input.cursor);
  if (Option.isSome(cursor) && cursor.value.mode !== undefined) {
    return { mode: cursor.value.mode, pinned: true };
  }
  return { mode: decodeAgentMode(input.requested) ?? DSH_DEFAULT_AGENT_MODE, pinned: false };
}

/**
 * dsh-only reply style. The engine writes most of what it finds into its
 * thinking stream, which the chat hides by design, so its visible replies were
 * arriving as bare "Now the X:" lead-ins whose facts never reached the owner.
 * This block is added only by this module, so no other harness carries it.
 */
const DSH_REPLY_STYLE_INSTRUCTIONS = `<reply_style>
Your thinking is hidden from the user: only the reply text reaches the chat. Put what you found, the numbers, the error text and your decisions in the reply itself, not only in your thinking.
Before a tool call, write one complete sentence saying what you found or what you are about to do. Never end a message with a colon.
Stay brief.
</reply_style>`;

/**
 * The persona text a launch carries: the runtime instructions, the dsh-only
 * reply style, then the bot's own instructions in their own tagged block.
 * Built with the same helper the Claude and OpenCode adapters use, so a bot
 * reads the same persona on either engine.
 */
export function buildDshPersona(
  systemInstructions: string | undefined,
  runtimeInstructions: string,
): string {
  const base = `${runtimeInstructions}\n\n${DSH_REPLY_STYLE_INSTRUCTIONS}`;
  const extra = systemInstructions?.trim();
  return extra === undefined || extra.length === 0
    ? base
    : `${base}\n\n<bot_instructions>${extra}</bot_instructions>`;
}

/**
 * DeepSeek's "DSML" tool-call markup as dsh leaks it into reply text. Tags are
 * fenced with the full-width bar (U+FF5C); the harness normally consumes a
 * call, but stray closers reached a chat on 2026-10-15.
 */
const DSH_MARKUP_BAR = "\uFF5C";
const DSH_MARKUP_MARKER = `${DSH_MARKUP_BAR}${DSH_MARKUP_BAR}DSML${DSH_MARKUP_BAR}${DSH_MARKUP_BAR}`;

/** A tag name as dsh spells one: `tool_calls`, `invoke`, `parameter`. */
const DSH_MARKUP_TAG_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

/** The `name="…"` attribute of an `invoke` tag, the tool's own name. */
const DSH_MARKUP_NAME_ATTRIBUTE = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * How much text an unfinished tag may hold back before it is let through as
 * ordinary text. A chunk boundary splits a tag, so a possible prefix is held;
 * anything bigger than this is not a tag, whatever it looks like.
 */
const DSH_MARKUP_MAX_HELD = 4096;

/** The closing form of a tag, matched against the open ones. */
type DshMarkupTag =
  | { readonly kind: "none" }
  | { readonly kind: "partial" }
  | {
      readonly kind: "tag";
      readonly name: string;
      readonly closing: boolean;
      /** An `invoke` tag's tool name. The only fact a log line ever carries. */
      readonly tool: string | undefined;
      /** Index just past the tag's `>`. */
      readonly end: number;
    };

/**
 * Reads one tag at `start` (which must be a `<`). "partial" means the buffer
 * ends inside a tag that is still possible, so the caller has to wait for the
 * next chunk; "none" means this `<` is ordinary text.
 */
function readDshMarkupTag(text: string, start: number): DshMarkupTag {
  let index = start + 1;
  let closing = false;
  if (text[index] === "/") {
    closing = true;
    index += 1;
  }
  // `<`, `<｜`, `<｜｜DSML` at a chunk boundary are all prefixes of the marker.
  const rest = text.slice(index, index + DSH_MARKUP_MARKER.length);
  if (rest !== DSH_MARKUP_MARKER) {
    return text.length - index < DSH_MARKUP_MARKER.length && DSH_MARKUP_MARKER.startsWith(rest)
      ? { kind: "partial" }
      : { kind: "none" };
  }
  index += DSH_MARKUP_MARKER.length;
  while (text[index] === " " || text[index] === "\t") index += 1;
  if (index >= text.length) return { kind: "partial" };
  const name = DSH_MARKUP_TAG_NAME.exec(text.slice(index))?.[0] ?? "";
  const end = findDshMarkupTagEnd(text, index + name.length);
  if (end < 0) return { kind: "partial" };
  const attributes = text.slice(index + name.length, end);
  return {
    kind: "tag",
    name,
    closing,
    tool: !closing && name === "invoke" ? readDshMarkupNameAttribute(attributes) : undefined,
    end: end + 1,
  };
}

/**
 * The `>` that closes a tag, skipping any inside a quoted attribute value.
 * A value is an attribute's business, not the reply's, so it must not be read
 * as the end of the tag.
 */
function findDshMarkupTagEnd(text: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
    // A `<` before the tag closes means this is not a tag after all.
    if (char === "<") return -1;
  }
  return -1;
}

function readDshMarkupNameAttribute(attributes: string): string | undefined {
  const match = DSH_MARKUP_NAME_ATTRIBUTE.exec(attributes);
  const value = (match?.[1] ?? match?.[2] ?? "").trim();
  return value.length > 0 ? value : undefined;
}

/** The length of the whitespace run that ends `text`. */
function trailingWhitespaceLength(text: string): number {
  let index = text.length;
  while (index > 0) {
    if (!isDshMarkupBlank(text[index - 1] ?? "")) break;
    index -= 1;
  }
  return text.length - index;
}

function isDshMarkupBlank(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

/**
 * One chunk of a reply the stripper let through: the text to show, and the tool
 * names of any calls it removed (never their arguments, which can hold secrets).
 */
export interface DshReplyStripChunk {
  readonly text: string;
  readonly tools: ReadonlyArray<string>;
}

export interface DshReplyStripper {
  /** Feeds one assistant text delta; returns the visible text it completes. */
  push(chunk: string): DshReplyStripChunk;
  /** Ends the turn: lets held text through and drops an unfinished block. */
  flush(): DshReplyStripChunk;
}

/**
 * Streaming stripper for dsh's leaked tool-call markup. Whole blocks go with
 * their arguments, stray closing tags go, and unmatched openers drop the rest
 * of the turn. Ordinary `<` text passes byte for byte; only a possible tag
 * prefix is held back.
 */
export function makeDshReplyStripper(): DshReplyStripper {
  let buffer = "";
  /** Tags being dropped, innermost last: `tool_calls`, `invoke`, `parameter`. */
  const open: Array<string> = [];

  const process = (final: boolean): DshReplyStripChunk => {
    const out: Array<string> = [];
    const tools: Array<string> = [];
    let index = 0;
    let emitted = 0;
    while (index < buffer.length) {
      const start = buffer.indexOf("<", index);
      if (start < 0) {
        index = buffer.length;
        break;
      }
      const tag = readDshMarkupTag(buffer, start);
      if (tag.kind === "none") {
        index = start + 1;
        continue;
      }
      if (tag.kind === "partial") {
        // A marker too long to still be one is ordinary text.
        if (buffer.length - start > DSH_MARKUP_MAX_HELD) {
          index = start + 1;
          continue;
        }
        // Inside a dropped block the whole region goes, tag or not.
        if (open.length > 0) {
          index = buffer.length;
          break;
        }
        if (final) {
          // A marker cut short at the end of the turn is still leaked markup;
          // a bare `<` (or `</`) is ordinary text and is shown.
          if (buffer.slice(start).includes(DSH_MARKUP_BAR)) {
            index = start;
            break;
          }
          index = start + 1;
          continue;
        }
        index = start;
        break;
      }
      // A complete tag. Only the text before it can be shown, and only when no
      // block is open; a stray closing tag takes its own line's blanks with it.
      if (open.length === 0) {
        let cut = start;
        if (tag.closing) {
          let blanks = start;
          while (blanks > emitted && isDshMarkupBlank(buffer[blanks - 1] ?? "")) blanks -= 1;
          if (buffer.slice(blanks, start).includes("\n")) cut = blanks;
        }
        out.push(buffer.slice(emitted, cut));
      }
      if (tag.closing) {
        const at = open.lastIndexOf(tag.name);
        if (at >= 0) open.length = at;
      } else {
        if (tag.tool !== undefined) tools.push(tag.tool);
        open.push(tag.name);
      }
      index = tag.end;
      if (open.length === 0) emitted = tag.end;
    }
    if (open.length > 0) {
      // An unfinished block is dropped, not shown; a closing tag may still be
      // split across the next chunk, so hold from the last `<`.
      if (final) buffer = "";
      else {
        const lastStart = buffer.lastIndexOf("<");
        buffer = lastStart >= emitted ? buffer.slice(lastStart) : "";
      }
    } else {
      const tail = buffer.slice(emitted, index);
      if (final) {
        out.push(tail);
        buffer = "";
      } else {
        const blanks = trailingWhitespaceLength(tail);
        const held = blanks > 0 && blanks <= DSH_MARKUP_MAX_HELD ? blanks : 0;
        out.push(buffer.slice(emitted, index - held));
        buffer = buffer.slice(index - held);
      }
    }
    return { text: out.join(""), tools };
  };

  return {
    push: (chunk: string) => {
      buffer += chunk;
      return process(false);
    },
    flush: () => process(true),
  };
}

/**
 * The longest visible segment that still counts as a short stub line. A reply
 * step that writes a whole paragraph before a tool call is prose, not a stub,
 * and keeps its own punctuation.
 */
export const DSH_COLON_STUB_MAX_LENGTH = 120;

export interface DshColonStubber {
  /** Feeds visible reply text; returns the part that is settled and shown. */
  push(text: string): string;
  /** A tool call starts: what the held tail becomes, or `""` when it held none. */
  closeByToolCall(): string;
  /** The turn ends: the held tail is shown unchanged. */
  flush(): string;
}

/**
 * Turns a short stub line's trailing `:` into `.` when a tool call follows,
 * and holds that colon until the next delta or the turn's end decides it.
 * Only a trimmed segment of at most DSH_COLON_STUB_MAX_LENGTH qualifies; code
 * fences, mid-line colons and longer prose pass through unchanged.
 */
export function makeDshColonStubber(): DshColonStubber {
  /** The provisional tail: a `:` plus the blanks that followed it. */
  let held = "";
  /** Visible characters since the last tool call (the segment the rule reads). */
  let segmentLength = 0;
  /** Where that segment's last non-blank character is, counting from its start. */
  let segmentTrimmedLength = 0;
  /** Inside an open ``` or ~~~ code fence: a colon there is code, not a stub. */
  let inFence = false;
  /** The fence run being read on this line, and whether it already toggled. */
  let fenceRun = "";
  let fenceRunLength = 0;
  let fenceRunToggled = false;
  /** Only blanks have been seen since the last newline. */
  let atLineStart = true;

  const trackFence = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] ?? "";
      if (char === "\n") {
        atLineStart = true;
        fenceRun = "";
        fenceRunLength = 0;
        fenceRunToggled = false;
        continue;
      }
      if (!atLineStart) continue;
      if (char === " " || char === "\t") continue;
      if (char === "`" || char === "~") {
        if (fenceRun === char) fenceRunLength += 1;
        else if (fenceRun === "") {
          fenceRun = char;
          fenceRunLength = 1;
        } else {
          // A mixed run is not a fence marker.
          atLineStart = false;
          continue;
        }
        if (fenceRunLength >= 3 && !fenceRunToggled) {
          inFence = !inFence;
          fenceRunToggled = true;
        }
        continue;
      }
      atLineStart = false;
    }
  };

  return {
    push: (text: string) => {
      if (text.length === 0) return "";
      // The held tail is provisional, so it is shown now and the new end of the
      // segment is read again below.
      let settled = held;
      held = "";
      trackFence(text);
      for (let index = 0; index < text.length; index += 1) {
        if (!isDshMarkupBlank(text[index] ?? "")) segmentTrimmedLength = segmentLength + index + 1;
      }
      segmentLength += text.length;
      const blanks = trailingWhitespaceLength(text);
      const colonAt = text.length - blanks - 1;
      if (text[colonAt] === ":" && !inFence && segmentTrimmedLength <= DSH_COLON_STUB_MAX_LENGTH) {
        held = text.slice(colonAt);
        return settled + text.slice(0, colonAt);
      }
      return settled + text;
    },
    closeByToolCall: () => {
      const tail = held;
      // The tool call closes the segment whether or not a colon was held.
      held = "";
      segmentLength = 0;
      segmentTrimmedLength = 0;
      // Only a `:` that passed the rule's own test was ever held, so it can
      // only be settled one way here.
      return tail.length === 0 ? "" : `.${tail.slice(1)}`;
    },
    flush: () => {
      const tail = held;
      held = "";
      segmentLength = 0;
      segmentTrimmedLength = 0;
      return tail;
    },
  };
}
