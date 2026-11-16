import { hasCachedThread } from "./nativeCache";
import { startChatOpen } from "./chatOpenIntent";
import { prefetchThreadSnapshot, snapshotSessionEnvironmentId } from "./threadSnapshotLoader";

/** Call from a row's onPress only: a swipe or a long press never reaches it. */
export function onChatPress(threadId: string): void {
  startChatOpen(threadId, {
    hasSavedCopy: (id) => {
      const environmentId = snapshotSessionEnvironmentId();
      return environmentId !== null && hasCachedThread(environmentId, id);
    },
    prefetch: prefetchThreadSnapshot,
  });
}
