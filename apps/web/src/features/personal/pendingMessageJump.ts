/**
 * A tap on a message search hit opens the chat; the chat then scrolls to that
 * message once it has loaded. The tap and the chat are different screens, so
 * the request waits here, per chat, and lapses so a stale one never fires on a
 * later visit.
 */
export const PENDING_MESSAGE_JUMP_TTL_MS = 6_000;

const pending = new Map<string, { readonly messageId: string; readonly expiresAt: number }>();

export function requestMessageJump(
  threadId: string,
  messageId: string,
  now: number = Date.now(),
): void {
  pending.set(threadId, { messageId, expiresAt: now + PENDING_MESSAGE_JUMP_TTL_MS });
}

/** The message this chat should scroll to, or null (none asked for, or it lapsed). */
export function peekMessageJump(threadId: string, now: number = Date.now()): string | null {
  const entry = pending.get(threadId);
  if (entry === undefined) return null;
  if (now >= entry.expiresAt) {
    pending.delete(threadId);
    return null;
  }
  return entry.messageId;
}

export function clearMessageJump(threadId: string): void {
  pending.delete(threadId);
}
