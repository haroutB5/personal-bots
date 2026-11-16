/**
 * The press that opens a chat. Its time is handed to the screen that mounts for that chat, so
 * the open is measured from the press and not from the mount. Times only: no chat text.
 */

/** A press older than this before the mount is not the cause of the open (a link opened it). */
export const TAP_MAX_AGE_MS = 5_000;

const taps = new Map<string, number>();

export function noteChatTap(threadId: string, at: number = performance.now()): void {
  taps.set(threadId, at);
}

/** The press time for the open that mounted at `openedAt`, or none. Each press is handed out once. */
export function takeChatTap(threadId: string, openedAt: number): number | undefined {
  const tap = taps.get(threadId);
  taps.delete(threadId);
  if (tap === undefined || openedAt - tap > TAP_MAX_AGE_MS) return undefined;
  return Math.min(tap, openedAt);
}
