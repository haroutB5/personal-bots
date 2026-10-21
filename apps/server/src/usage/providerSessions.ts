/**
 * Which provider session a chat resumes, in the one place both the token usage
 * table and the persistence layer read it. The provider runtime cursor is the
 * only thing that names a session, and every provider shapes it differently.
 *
 * @module providerSessions
 */
import type { UsageProviderKind } from "@t3tools/contracts";

/** The usage provider a `provider_session_runtime.provider_name` names. */
export function usageProviderOf(providerName: string): UsageProviderKind | null {
  switch (providerName) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "deepseek":
      return "deepseek";
    case "antigravity":
      return "antigravity";
    case "grok":
      return "grok";
    default:
      return null;
  }
}

/** The session id a resume cursor names, or null when it names none. */
export function sessionIdFromCursor(provider: UsageProviderKind, cursor: unknown): string | null {
  if (typeof cursor !== "object" || cursor === null) return null;
  // DeepSeek resumes through the same Claude-shaped cursor (`resume`), so it
  // reads like Claude; the rest keep their own field.
  const field =
    provider === "claude" || provider === "deepseek"
      ? "resume"
      : provider === "codex"
        ? "threadId"
        : "sessionId";
  const value = (cursor as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The session id a chat's resume cursor names, or null when it names none. */
export function sessionIdFromResumeCursor(
  provider: UsageProviderKind,
  resumeCursorJson: string | null,
): string | null {
  if (resumeCursorJson === null) return null;
  let cursor: unknown;
  try {
    cursor = JSON.parse(resumeCursorJson);
  } catch {
    return null;
  }
  return sessionIdFromCursor(provider, cursor);
}

/**
 * The Token usage table attributes a chat to its bot through the session id the
 * chat resumes. A resume cursor is overwritten on every turn (Claude even moves
 * to a new session), so past sessions were lost and their tokens showed up as
 * "other". This flag makes `provider_session_history` remember every session a
 * chat has used; `=off` leaves the history table untouched and unattributed
 * sessions go back to "other".
 */
export const providerSessionHistoryEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.PERSONAL_TOKEN_USAGE_SESSION_HISTORY !== "off";
