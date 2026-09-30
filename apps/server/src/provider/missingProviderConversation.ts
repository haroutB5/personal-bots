/**
 * The provider no longer has the conversation a session tried to resume.
 *
 * Claude Code exits with "No conversation found with session ID: <id>" when
 * its transcript is gone (a prewarmed session that never ran a turn never
 * wrote one). Codex answers thread/resume with a "not found" family of errors
 * (its runtime already falls back to a fresh thread; these are for any path
 * that surfaces one anyway). Either way resuming again cannot work: the turn
 * needs a fresh session with the chat carried over.
 */
const MISSING_CONVERSATION_PATTERNS: ReadonlyArray<RegExp> = [
  /no conversation found with session id/i,
  /no rollout found/i,
  /\bthread\b[^\n]{0,80}\bnot found\b/i,
  /\b(?:missing|unknown|no such) thread\b/i,
];

export function isMissingProviderConversationText(text: string | null | undefined): boolean {
  if (text === null || text === undefined || text.length === 0) return false;
  return MISSING_CONVERSATION_PATTERNS.some((pattern) => pattern.test(text));
}

/** The first line naming the missing conversation, for errors and logs. */
export function missingProviderConversationLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => isMissingProviderConversationText(line));
}
