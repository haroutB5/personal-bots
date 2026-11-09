import type { PendingOutgoingMessage } from "./types.ts";

/**
 * The optimistic "Sending" rows to draw in `threadId`.
 * The conversation route keeps one screen mounted while its `threadId` param
 * changes, so the pending list outlives a switch to another chat, and a send
 */
export function pendingForThread(
  pending: ReadonlyArray<PendingOutgoingMessage>,
  threadId: string,
  messages: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<PendingOutgoingMessage> {
  if (pending.length === 0) return pending;
  const echoed = new Set(messages.map((message) => message.id as string));
  return pending.filter((message) => message.threadId === threadId && !echoed.has(message.id));
}
