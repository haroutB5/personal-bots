import type { HbotsNotifyModule } from "./nativeNotify";

/**
 * Opening a chat reads what its notifications said, so they leave the shade. Without FCM there is no
 * cancel push to do it. A chat that is not a real thread (a new chat has no id yet) clears nothing.
 */
export function clearChatNotifications(
  threadId: string,
  native: Pick<HbotsNotifyModule, "cancelForChat"> | null,
): boolean {
  if (native === null || threadId === "") return false;
  native.cancelForChat(threadId);
  return true;
}
