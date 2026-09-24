/**
 * Notifications that are already stale once the user is in the app.
 *
 * iOS gives an app that is in front no event when one of its notifications is
 * tapped in Notification Center (the same limit the in-app banner works
 * around), so an old "X replied" tapped from inside the app does nothing at
 * all. Rather than leave dead rows behind, the page closes them: all of them
 * when it comes to the front (the chats list shows what is unread), and the
 * ones for a chat when that chat opens (desktop and Android, where the app can
 * sit open in a background window while pushes arrive).
 */
import { useEffect } from "react";

export interface ClosableNotification {
  readonly tag?: string;
  readonly data?: unknown;
  readonly close: () => void;
}

export interface NotificationSource {
  readonly getNotifications?: () => Promise<ReadonlyArray<ClosableNotification>>;
}

/** The deep link a notification opens, as the worker stored it. */
export function notificationUrl(notification: ClosableNotification): string | null {
  const data = notification.data;
  if (typeof data !== "object" || data === null) return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

function samePath(url: string, path: string): boolean {
  const bare = url.split(/[?#]/)[0]!.replace(/\/+$/, "");
  if (bare === path) return true;
  try {
    return decodeURIComponent(bare) === decodeURIComponent(path);
  } catch {
    return false;
  }
}

/** Does this notification open the chat `threadId` of `botId`? */
export function isChatNotification(
  notification: ClosableNotification,
  botId: string,
  threadId: string,
): boolean {
  if (notification.tag === `chat-${threadId}`) return true;
  const url = notificationUrl(notification);
  if (url === null) return false;
  return samePath(url, `/bots/${encodeURIComponent(botId)}/${encodeURIComponent(threadId)}`);
}

/**
 * Closes every notification `match` accepts and returns how many it closed.
 * No worker, no `getNotifications` (older engines) or a failure: closes none.
 */
export async function closeNotifications(
  source: NotificationSource | null | undefined,
  match: (notification: ClosableNotification) => boolean = () => true,
): Promise<number> {
  if (source == null || typeof source.getNotifications !== "function") return 0;
  let list: ReadonlyArray<ClosableNotification>;
  try {
    list = await source.getNotifications();
  } catch {
    return 0;
  }
  let closed = 0;
  for (const notification of list) {
    if (!match(notification)) continue;
    try {
      notification.close();
      closed += 1;
    } catch {
      // One that will not close must not keep the rest open.
    }
  }
  return closed;
}

/** The page's own worker registration, or null where there is none. */
export async function notificationRegistration(): Promise<NotificationSource | null> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    return (await navigator.serviceWorker.getRegistration("/")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Closes this chat's notifications when it opens, and again whenever it comes
 * back to the front while open: once the chat is on screen they say nothing new.
 */
export function useCloseChatNotifications(botId: string, threadId: string): void {
  useEffect(() => {
    const close = () => {
      if (document.visibilityState !== "visible") return;
      void notificationRegistration()
        .then((registration) =>
          closeNotifications(registration, (notification) =>
            isChatNotification(notification, botId, threadId),
          ),
        )
        .catch(() => undefined);
    };
    close();
    document.addEventListener("visibilitychange", close);
    return () => document.removeEventListener("visibilitychange", close);
  }, [botId, threadId]);
}
