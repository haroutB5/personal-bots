/**
 * The press that opens a chat. Its time goes to the screen that mounts for that chat, so the
 * open is measured from the press. On a chat that must come from the server, the press also
 * starts the snapshot request, which the mount then picks up. Times and ids only: no chat text.
 */

import { androidPerfOptimizationOn } from "../perfFlags";

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

/**
 * How long a closed chat stays in memory: the thread resume cache (client-runtime
 * threadRetention.ts THREAD_SNAPSHOT_IDLE_TTL_MS). Opening one in that window asks nobody.
 */
export const HELD_MEMORY_TTL_MS = 5 * 60_000;

/** When each chat the screen showed was let go; infinity while it is still shown. */
const held = new Map<string, number>();

/** The chat is on screen with data, and for HELD_MEMORY_TTL_MS after the returned release. */
export function holdChat(threadId: string): () => void {
  held.set(threadId, Number.POSITIVE_INFINITY);
  return () => {
    held.set(threadId, performance.now());
  };
}

export function chatInMemory(threadId: string, now: number = performance.now()): boolean {
  const releasedAt = held.get(threadId);
  return releasedAt !== undefined && now - releasedAt <= HELD_MEMORY_TTL_MS;
}

export interface ChatPressDeps {
  /** Whether an encrypted copy of the chat sits on the phone (an open with one never asks). */
  readonly hasSavedCopy: (threadId: string) => boolean;
  readonly prefetch: (threadId: string) => void;
}

export type ChatPressOutcome = "prefetched" | "switched-off" | "in-memory" | "saved-copy";

/**
 * A press on a chat row. Always notes the tap time. Starts the snapshot request only for a
 * chat with nothing local to paint from, and only while `android-preload-chat` is on.
 */
export function startChatOpen(threadId: string, deps: ChatPressDeps): ChatPressOutcome {
  noteChatTap(threadId);
  if (!androidPerfOptimizationOn("android-preload-chat")) return "switched-off";
  if (chatInMemory(threadId)) return "in-memory";
  if (deps.hasSavedCopy(threadId)) return "saved-copy";
  deps.prefetch(threadId);
  return "prefetched";
}
