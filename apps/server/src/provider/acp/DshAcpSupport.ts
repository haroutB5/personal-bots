/**
 * DeepSeek Harness (dsh) support: the runtime pin, the child environment, the
 * per-launch overlay patch, and the ACP runtime the adapter drives.
 *
 * dsh runs as one process per chat, in ACP mode (`--profile acp`) over stdio,
 * launched with a generated `--patch` file that carries the bot's persona,
 * its skill folders and its agent mode in one place.
 *
 * Three rows of that patch are privacy-critical and must be in every launch:
 * without them dsh attaches the full canonical session log (system prompt,
 * tool calls and results, file contents, shell output) to every model request
 * and bills a model turn per `web_search`. See `DESIGN.md` section 5.
 *
 * @module provider/acp/DshAcpSupport
 */
import {
  DEEPSEEK_AGENT_MODE_OPTION_ID,
  DEEPSEEK_DEFAULT_AGENT_MODE,
  DEEPSEEK_DSH_AGENT_MODES,
  DEEPSEEK_FLASH_MODEL,
  type DeepSeekDshAgentMode,
  type DeepSeekSettings,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as NodeOS from "node:os";

import { expandHomePath } from "../../pathExpansion.ts";
import { BOT_PROTECTED_DB_SIDECAR_SUFFIXES } from "../../personal/secrets/botProtectedPaths.ts";
import { DEEPSEEK_AUTH_TOKEN_ENV, isLeakedSecretName } from "../Drivers/DeepSeekEnvironment.ts";
import { DSH_PINNED_VERSION, DSH_RUNTIME_DIR_NAME } from "../Drivers/DeepSeekEngine.ts";
import { PERSONAL_BOT_PLUGINS_DIR, PERSONAL_BOT_SHARED_PLUGIN } from "../Layers/ClaudeAdapter.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const DSH_AGENT_MODES = DEEPSEEK_DSH_AGENT_MODES;
export type DshAgentMode = DeepSeekDshAgentMode;
export const DSH_DEFAULT_AGENT_MODE: DshAgentMode = DEEPSEEK_DEFAULT_AGENT_MODE;
export { DEEPSEEK_AGENT_MODE_OPTION_ID, DSH_PINNED_VERSION };

/** The key dsh reads, and the only credential its child environment carries. */
export const DEEPSEEK_DSH_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** Where a bot's own plugin folder keeps its skills, from its plugin manifest. */
const PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"] as const;
const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Rows the patch must always carry. Named here so the patch builder and the
 * unit test that guards them cannot drift apart: the first stops dsh
 * uploading the canonical session log with every model request, the second
 * its OTEL session telemetry, the third its paid `web_search`.
 */
export const DSH_SESSION_LOG_ROW_ID = "session-log-deepseek";
export const DSH_TELEMETRY_ROW_ID = "session-telemetry-otel";
export const DSH_WEB_SEARCH_ROW_ID = "web-search-deepseek";
/** The plugin inventory dsh otherwise sends with every request. */
export const DSH_PLUGIN_INVENTORY_ROW_ID = "plugin-package-inventory-deepseek";

/** The bot-state deny plugin, installed beside the runtime pin. */
export const DSH_DENY_PLUGIN_FILE = "hbots-deny-plugin.mjs";
/** The row the deny plugin is loaded under. */
export const DSH_DENY_ROW_ID = "hbots-deny";

export interface DshRuntime {
  readonly runtimeDir: string;
  /** The dsh entry point, run with hbots' own `node.exe`. */
  readonly binJs: string;
  readonly version: string;
}

/** `~/.personal-bots/runtimes/dsh-0.2.0-rc.2` — never inside a release folder. */
export const defaultDshRuntimeDir = (): string =>
  [NodeOS.homedir(), ".personal-bots", "runtimes", DSH_RUNTIME_DIR_NAME].join("/");

/**
 * The installed dsh runtime: the instance's own path when it names one, else
 * the pinned per-machine install. Nothing is probed here; the provider status
 * check runs `--version` against `binJs`.
 */
export const resolveDshRuntime = Effect.fn("resolveDshRuntime")(function* (
  settings: Pick<DeepSeekSettings, "dshRuntimePath">,
): Effect.fn.Return<DshRuntime, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = settings.dshRuntimePath.trim();
  const runtimeDir = path.resolve(
    configured.length > 0 ? expandHomePath(configured) : defaultDshRuntimeDir(),
  );
  return {
    runtimeDir,
    binJs: path.join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    version: DSH_PINNED_VERSION,
  };
});

/** What the provider card says when the runtime is not installed or is another build. */
export const DSH_RUNTIME_MISSING_MESSAGE =
  "DeepSeek Harness runtime missing: run scripts/personal/install-dsh.ps1";

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
    name.startsWith("DEEPSEEK_")
  );
}

/**
 * Case-insensitive de-duplication of environment names, keeping the first
 * spelling seen. PowerShell 5.1 inside a dsh tool fails on `Get-ChildItem
 * Env:` when the process environment holds `Path` and `PATH` at once ("An
 * item with the same key has already been added"), and a spawned tool
 * inherits exactly that.
 */
export function dedupeEnvironmentNames(
  environment: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const seen = new Map<string, string>();
  const spelled = new Map<string, string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, value);
    spelled.set(key, name);
  }
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of seen) next[spelled.get(key) ?? key] = value;
  return next;
}

/**
 * The dsh child environment: the instance's own environment (device variables
 * already applied, as Grok does) with the leaked secrets, the Claude-engine
 * pins and every ambient DeepSeek key removed; the instance's
 * `ANTHROPIC_AUTH_TOKEN` becomes `DEEPSEEK_API_KEY`, and the harness gets its
 * own home, its telemetry off and a permission mode that matches the chat's
 * runtime mode.
 *
 * The key lives only here. It never enters the launch patch, the arguments or
 * any log line, and dsh keeps it out of the shells its tools start.
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
 * dsh interpolates `{{name}}` in persona text and throws on an unknown
 * variable, which would fail every request in the session. A bot whose
 * instructions mention `{{...}}` would take its own chat down, so every
 * opening brace pair in bot-authored text is broken with a zero-width space:
 * invisible in the model's reading of it, and no longer a placeholder to dsh.
 */
export function escapeDshPersonaText(text: string): string {
  return text.replaceAll("{{", "{​{");
}

/**
 * The bot-state deny plugin as one launch row. hbots computes the real paths
 * from `ServerDerivedPaths`, so the plugin file itself ships static with the
 * runtime pin and never has to know a data root.
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
 * and `minimal` keeps one persistent PowerShell plus whatever MCP servers the
 * client mounted.
 */
function modeRows(mode: DshAgentMode): ReadonlyArray<Record<string, unknown>> {
  if (mode === "code") return [{ id: "tools", config: { mode: "ptc" } }];
  if (mode === "minimal") return MINIMAL_DISABLED_ROWS.map((id) => ({ id, disabled: true }));
  return [];
}

/** Minimal mode's own extra rows: one persistent PowerShell, plus MCP tools. */
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
 * The launch overlay, in row order. dsh reads it as YAML, and JSON is valid
 * YAML, so it is written as JSON: the persona is bot-authored text with
 * quotes, colons, `#` and backslashes in it.
 *
 * Flash is pinned twice (the model an ACP session starts on, and the agent
 * default) so no alias can route a turn to Pro. `web_fetch` stays on over
 * plain HTTP; dsh's own paid `web_search` is off because bots have hbots' own
 * `search_web`.
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

/** Writes the patch next to the harness home. Its content is never logged. */
export const writeDshLaunchPatch = Effect.fn("writeDshLaunchPatch")(function* (input: {
  readonly dshHome: string;
  readonly threadId: string;
  readonly patch: string;
}): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.dshHome, "launch");
  const file = path.join(directory, `${input.threadId}.json`);
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore);
  yield* fileSystem.writeFileString(file, input.patch).pipe(Effect.ignore);
  return file;
});

/** Removes a session's patch once its process has stopped. */
export const removeDshLaunchPatch = Effect.fn("removeDshLaunchPatch")(function* (input: {
  readonly dshHome: string;
  readonly threadId: string;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem
    .remove(path.join(input.dshHome, "launch", `${input.threadId}.json`), { force: true })
    .pipe(Effect.ignore);
});

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
 * The dsh session state a cursor carries, or nothing when the cursor belongs
 * to another engine (a Claude Code session id) or is malformed. A cursor from
 * the Claude engine is not an error in itself: the adapter fails the first
 * turn with the missing-conversation text so the server renews the session
 * and carries the chat over from its text.
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
 * The skill folders a launch names, from the same sources the Claude engine
 * uses: the shared plugin folder, the bot's own, and the workspace's own
 * skill directories.
 *
 * dsh does not scan `.claude/skills`, so those roots are named explicitly;
 * `includeDefaultRoots: false` keeps the machine owner's `~/.agents/skills`
 * out of a bot's skill list.
 */
export const resolveDshSkillDirs = Effect.fn("resolveDshSkillDirs")(function* (input: {
  readonly baseDir: string;
  readonly botId: string | undefined;
  readonly cwd: string;
}): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsRoot = path.join(input.baseDir, PERSONAL_BOT_PLUGINS_DIR);
  const pluginDirs = [
    path.join(pluginsRoot, PERSONAL_BOT_SHARED_PLUGIN),
    ...(input.botId !== undefined && BOT_ID_PATTERN.test(input.botId)
      ? [path.join(pluginsRoot, input.botId)]
      : []),
  ];
  const dirs: string[] = [];
  for (const pluginDir of pluginDirs) {
    const manifestPath = path.join(pluginDir, ...PLUGIN_MANIFEST_PATH);
    const exists = yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) continue;
    const text = yield* fileSystem
      .readFileString(manifestPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const skills = readManifestSkillsField(text);
    if (skills === undefined) continue;
    const dir = path.resolve(pluginDir, skills);
    const hasDir = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (hasDir) dirs.push(dir);
  }
  for (const relative of [".claude/skills", ".agents/skills"]) {
    const dir = path.resolve(input.cwd, relative);
    const hasDir = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (hasDir) dirs.push(dir);
  }
  return dirs;
});

/** The `skills` path a plugin manifest names, when it is a usable relative path. */
function readManifestSkillsField(text: string): string | undefined {
  if (text.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const skills = (parsed as Record<string, unknown>)["skills"];
  if (typeof skills !== "string") return undefined;
  const trimmed = skills.trim();
  if (trimmed.length === 0) return undefined;
  // A plugin manifest is data on disk. An absolute path, or one climbing out
  // of the plugin folder, would widen a bot's skill roots beyond its own.
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
    return undefined;
  }
  return trimmed.split(/[\\/]/).includes("..") ? undefined : trimmed;
}

/**
 * The deny plugin a launch loads, from the server's own paths.
 *
 * dsh has no equivalent of Claude Code's `permissions.deny`, so a bot in full
 * access could read the sealed secret store and the data-encryption key inside
 * it, or rewrite the database. The plugin restores that guardrail at the same
 * level as Claude's: a tool-level deny, not an OS boundary.
 *
 * `<baseDir>/dsh` is dsh-specific: a bot could otherwise write
 * `<DSH_HOME>/profiles/acp/cordis.patch.yml` and change the harness every
 * other bot in this data root starts from.
 *
 * Returns nothing when `PERSONAL_BOT_STATE_DENY=off`, which is the one-flip
 * way back to the Codex-level parity the engine had before this plugin.
 */
export const resolveDshDenyPlugin = Effect.fn("resolveDshDenyPlugin")(function* (input: {
  readonly runtimeDir: string;
  readonly paths: {
    readonly secretsDir: string;
    readonly dbPath: string;
  };
  readonly dshHome: string;
  readonly enabled: boolean;
}): Effect.fn.Return<DshDenyPluginInput | undefined, never, Path.Path> {
  if (!input.enabled) return undefined;
  const path = yield* Path.Path;
  const pluginPath = path.join(input.runtimeDir, DSH_DENY_PLUGIN_FILE);
  const url = yield* path
    .toFileUrl(pluginPath)
    .pipe(Effect.orElseSucceed(() => ({ href: pluginPath }) as URL));
  return {
    pluginUrl: url.href,
    denyReadWrite: [input.paths.secretsDir],
    denyWrite: [
      input.paths.dbPath,
      ...BOT_PROTECTED_DB_SIDECAR_SUFFIXES.map((suffix) => `${input.paths.dbPath}${suffix}`),
      input.dshHome,
    ],
  };
});

/**
 * Removes launch patches left behind by a session that never got to delete
 * its own (a crash, or the server being killed). They hold bot instructions,
 * not secrets, but a stale one describes a chat that is gone.
 */
export const sweepDshLaunchDir = Effect.fn("sweepDshLaunchDir")(function* (input: {
  readonly dshHome: string;
}): Effect.fn.Return<number, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.dshHome, "launch");
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const removedThis = yield* fileSystem.remove(path.join(directory, entry), { force: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (removedThis) removed += 1;
  }
  return removed;
});

/**
 * The persona text a launch carries: the runtime instructions, then the bot's
 * own instructions in their own tagged block. Built with the same helper the
 * Claude and OpenCode adapters use, so a bot reads the same persona on either
 * engine (`botInstructionCoverage` walks this module's import closure).
 */
export function buildDshPersona(
  systemInstructions: string | undefined,
  runtimeInstructions: string,
): string {
  const extra = systemInstructions?.trim();
  return extra === undefined || extra.length === 0
    ? runtimeInstructions
    : `${runtimeInstructions}\n\n<bot_instructions>${extra}</bot_instructions>`;
}

export interface DshAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "clientInfo" | "resumeMethod"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

/**
 * The ACP runtime for one dsh chat.
 *
 * `resume`, not `load`: dsh does not implement `session/load`. Cancellation
 * waits for the prompt response, as Antigravity's does, so a cancelled turn's
 * `tool_call_update` and its terminal `stopReason` are still delivered. dsh
 * reads and writes the workspace itself and never opens a terminal over ACP,
 * so both client capabilities stay off.
 */
export const makeDshAcpRuntime = Effect.fn("makeDshAcpRuntime")(function* (
  input: DshAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      clientInfo: { name: "t3-code", version: "0.0.0" },
      // dsh answers `authenticate` with an immediate success whatever the
      // method id, so the id only has to be present.
      authMethodId: "none",
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
