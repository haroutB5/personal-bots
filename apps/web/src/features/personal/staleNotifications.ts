/**
 * Notifications the user has already seen in the app.
 *
 * Only one kind is ever closed from the page: the notifications of a chat
 * that is open on screen (see `useCloseChatNotifications`). Reading the chat
 * is reading its news, like Messages clearing a conversation's alerts.
 *
 * Nothing else is closed, ever. Until 1.46 the app closed every notification
 * a few seconds after it came to the front, on the theory that the chats list
 * shows what is unread. In practice that took the notifications Harout had not
 * tapped yet with it: tap the newest one and the older ones vanished (26 Sep,
 * closed:2 right after a tap). Closing on resume also cancelled taps outright
 * in 1.36 (24 Sep: four taps logged as notifications-cleared {closed:1} with no
 * notificationclick), because iOS brings the app to the front before it
 * dispatches the click, and a notification the page closes in between takes
 * its click with it. A notification now leaves Notification Center only when
 * it is tapped (the worker closes it), when a newer one for the same chat
 * replaces it (one row per chat, see the worker's tag), when its chat is read
 * here, or when the user dismisses it.
 */
import { useEffect } from "react";

/**
 * How long after the app comes back before an open chat's notifications are
 * closed. A tap's click reaches the worker within about a second of the resume
 * in the server logs; this leaves room for a slow wake.
 */
export const CLEAR_STALE_NOTIFICATIONS_DELAY_MS = 8_000;

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
  match: (notification: ClosableNotification) => boolean,
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
 * The return to the front waits CLEAR_STALE_NOTIFICATIONS_DELAY_MS, so a tap on
 * one of them still lands. Other chats' notifications are never touched.
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
    let timer: number | null = null;
    const onVisibility = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        close();
      }, CLEAR_STALE_NOTIFICATIONS_DELAY_MS);
    };
    close();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [botId, threadId]);
}
