/**
 * Context caps for personal-bot sessions. Task and routine chats auto-compact (Claude 200k window,
 * Codex 150k tokens; `PERSONAL_TASK_AUTO_COMPACT=off` restores provider defaults). Shell output past
 * about 12k characters stays out of context (`PERSONAL_BOT_SHELL_OUTPUT_CAP=off` or a number 4000 to 128000).
 */
export const PERSONAL_TASK_AUTO_COMPACT_ENV = "PERSONAL_TASK_AUTO_COMPACT";
/** Claude's `autoCompactWindow` for task chats; it compacts a little below it. */
export const CLAUDE_TASK_AUTO_COMPACT_WINDOW = 200_000;
/** Codex's `model_auto_compact_token_limit` for task chats. */
export const CODEX_TASK_AUTO_COMPACT_TOKEN_LIMIT = 150_000;

type Env = Readonly<Record<string, string | undefined>>;

const OFF_WORDS = new Set(["off", "0", "false", "no", "none", "disabled"]);

const isOff = (value: string | undefined): boolean =>
  value !== undefined && OFF_WORDS.has(value.trim().toLowerCase());

/** Whether task and routine chats get their own auto-compaction. */
export function taskAutoCompactEnabled(env: Env = process.env): boolean {
  return !isOff(env[PERSONAL_TASK_AUTO_COMPACT_ENV]);
}

/** Claude compacts this far below its window (measured on Claude Code 2.1.305). */
const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;
/** The largest window Claude accepts. */
const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

/**
 * The Claude `autoCompactWindow` a session runs with, or undefined for the CLI's own.
 * In a bot chat the owner's "Auto-compact after" number always wins, raised by Claude's
 * reserve so compaction lands on it. A task chat uses 200k only when the owner set nothing.
 */
export function claudeAutoCompactWindow(input: {
  readonly configured: string | undefined;
  readonly personalBot: boolean;
  readonly personalTaskChat: boolean;
  readonly env?: Env;
}): number | undefined {
  const configured =
    input.configured !== undefined && input.configured.trim().length > 0
      ? Number(input.configured)
      : undefined;
  const owner = configured !== undefined && Number.isFinite(configured) ? configured : undefined;
  if (!input.personalBot) return owner;
  if (owner !== undefined) {
    return Math.min(owner + CLAUDE_AUTO_COMPACT_RESERVE_TOKENS, CLAUDE_AUTO_COMPACT_WINDOW_MAX);
  }
  if (!input.personalTaskChat) return undefined;
  return taskAutoCompactEnabled(input.env ?? process.env)
    ? CLAUDE_TASK_AUTO_COMPACT_WINDOW
    : undefined;
}

/**
 * The Codex app-server config overrides that make a task or routine chat
 * compact at 150k tokens, or none for the owner's own chats (and with the
 * kill switch off).
 */
export function codexTaskAutoCompactArgs(input: {
  readonly personalBot: boolean;
  readonly personalTaskChat: boolean;
  readonly env?: Env;
}): ReadonlyArray<string> {
  if (!input.personalBot || !input.personalTaskChat) return [];
  if (!taskAutoCompactEnabled(input.env ?? process.env)) return [];
  return ["-c", `model_auto_compact_token_limit=${CODEX_TASK_AUTO_COMPACT_TOKEN_LIMIT}`];
}

export const PERSONAL_BOT_SHELL_OUTPUT_CAP_ENV = "PERSONAL_BOT_SHELL_OUTPUT_CAP";
export const BOT_SHELL_OUTPUT_DEFAULT_CHARS = 12_000;
/** The range Claude Code clamps `bashOutputMaxChars` to (CLI 2.1.304). */
export const BOT_SHELL_OUTPUT_MIN_CHARS = 4_000;
export const BOT_SHELL_OUTPUT_MAX_CHARS = 128_000;
/** Characters per token for the Codex limit, the usual rough English ratio. */
const CHARS_PER_TOKEN = 4;

/** The shell output cap in characters for a bot session, or undefined when off. */
export function botShellOutputCapChars(env: Env = process.env): number | undefined {
  const raw = env[PERSONAL_BOT_SHELL_OUTPUT_CAP_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return BOT_SHELL_OUTPUT_DEFAULT_CHARS;
  if (isOff(raw)) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return BOT_SHELL_OUTPUT_DEFAULT_CHARS;
  return Math.min(Math.max(parsed, BOT_SHELL_OUTPUT_MIN_CHARS), BOT_SHELL_OUTPUT_MAX_CHARS);
}

/** The Claude settings that cap a bot's shell output, or none for other threads. */
export function claudeShellOutputSettings(input: {
  readonly personalBot: boolean;
  readonly env?: Env;
}): { readonly bashOutputMaxChars?: number } {
  if (!input.personalBot) return {};
  const chars = botShellOutputCapChars(input.env ?? process.env);
  return chars === undefined ? {} : { bashOutputMaxChars: chars };
}

/** The Codex app-server overrides that cap a bot's tool output, or none. */
export function codexShellOutputArgs(input: {
  readonly personalBot: boolean;
  readonly env?: Env;
}): ReadonlyArray<string> {
  if (!input.personalBot) return [];
  const chars = botShellOutputCapChars(input.env ?? process.env);
  return chars === undefined
    ? []
    : ["-c", `tool_output_token_limit=${Math.ceil(chars / CHARS_PER_TOKEN)}`];
}
