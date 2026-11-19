import { hasCachedThread } from "./nativeCache";
import { startChatOpen } from "./chatOpenIntent";
import { prefetchThreadSnapshot, snapshotSessionEnvironmentId } from "./threadSnapshotLoader";

/**
 * Call only when a chat is about to open (shell/openChat.ts): a swipe or a long press on a row never reaches it. The early request is
 * a speed-up, so whatever fails here (an unreadable cache folder, a bad id) must never stop the
 * open that follows, which then runs as it did before the early request existed.
 */
export function onChatPress(threadId: string): void {
  try {
    startChatOpen(threadId, {
      hasSavedCopy: (id) => {
        const environmentId = snapshotSessionEnvironmentId();
        return environmentId !== null && hasCachedThread(environmentId, id);
      },
      prefetch: prefetchThreadSnapshot,
    });
  } catch {
    // The open reads the chat the way it always did.
  }
}

/** The early snapshot request, then the open. */
export function pressChat(threadId: string, open: () => void): void {
  onChatPress(threadId);
  open();
}
