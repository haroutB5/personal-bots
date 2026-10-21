/**
 * Context caps for personal-bot sessions (1.66.80, token audit 21 Oct 2026).
 * Every step of a session re-reads all of it, so a long task chat is what
 * burns the usage limits. Each cap has its own kill switch, read from the
 * server environment when a session starts.
 *
 * - Auto-compaction for chats made for a delegated task or a routine run
 *   (`personalTaskChat` on the start input), never for the owner's own chats:
 *   Claude compacts with a 200k window, Codex at 150k tokens.
 *   `PERSONAL_TASK_AUTO_COMPACT=off` restores the provider defaults.
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

/**
 * The Claude `autoCompactWindow` a session runs with, or undefined for the
 * CLI's own. The owner's provider setting (`configured`, "" when unset)
 * applies everywhere as before; a task chat compacts at 200k, or sooner when
 * the owner's setting is smaller.
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
  if (!input.personalBot || !input.personalTaskChat) return owner;
  if (!taskAutoCompactEnabled(input.env ?? process.env)) return owner;
  return owner === undefined
    ? CLAUDE_TASK_AUTO_COMPACT_WINDOW
    : Math.min(owner, CLAUDE_TASK_AUTO_COMPACT_WINDOW);
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
