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
 *
 * Never at the moment the app comes back, though. Tapping a notification on
 * iOS brings the app to the front first and dispatches notificationclick to
 * the worker afterwards; a notification the page closes in between takes its
 * click with it, and the app just resumes where it was (24 Sep: four taps
 * logged as notifications-cleared {closed:1} with no notificationclick). So
 * the closing waits CLEAR_STALE_NOTIFICATIONS_DELAY_MS after the last resume.
 */
import { useEffect } from "react";

/**
 * How long after the app comes back before notifications count as stale. A
 * tap's click reaches the worker within about a second of the resume in the
 * server logs; this leaves room for a slow wake.
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

export type StaleClearReason = "boot" | "visible" | "focus";

export interface DeferredNotificationClearDeps {
  /** Closes the stale notifications and resolves how many it closed. */
  readonly close: () => Promise<number>;
  readonly isVisible: () => boolean;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly report?: (record: Record<string, unknown>) => void;
  readonly delayMs?: number;
}

export interface DeferredNotificationClear {
  /** The app came back (or booted visible): clear once it has settled. */
  readonly schedule: (reason: StaleClearReason) => void;
  /** The app went to the background before the clear ran. */
  readonly cancel: () => void;
  /** A notification tap landed while a clear was waiting. */
  readonly noteTap: () => void;
  readonly dispose: () => void;
}

/**
 * Clears stale notifications a while after the app comes back, never while a
 * tap may still be on its way to the worker. Repeated resume signals (iOS
 * sends visibilitychange and focus twice together) collapse into one clear.
 */
export function createDeferredNotificationClear(
  deps: DeferredNotificationClearDeps,
): DeferredNotificationClear {
  const delayMs = deps.delayMs ?? CLEAR_STALE_NOTIFICATIONS_DELAY_MS;
  let timer: unknown = null;
  let reason: StaleClearReason | null = null;
  let since = 0;
  let afterTap = false;

  const reset = () => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    reason = null;
    afterTap = false;
  };

  const run = () => {
    const record = { reason, waitedMs: deps.now() - since, afterTap };
    timer = null;
    reason = null;
    afterTap = false;
    if (!deps.isVisible()) return;
    void deps
      .close()
      .then((closed) => {
        if (closed > 0) deps.report?.({ event: "notifications-cleared", ...record, closed });
      })
      .catch(() => undefined);
  };

  return {
    schedule: (next) => {
      if (timer === null) {
        reason = next;
        since = deps.now();
      } else {
        deps.clearTimeout(timer);
      }
      timer = deps.setTimeout(run, delayMs);
    },
    cancel: () => {
      if (timer === null) return;
      deps.report?.({
        event: "notifications-clear-skipped",
        reason,
        waitedMs: deps.now() - since,
        afterTap,
      });
      reset();
    },
    noteTap: () => {
      if (timer !== null) afterTap = true;
    },
    dispose: reset,
  };
}

/**
 * Closes this chat's notifications when it opens, and again whenever it comes
 * back to the front while open: once the chat is on screen they say nothing new.
 * The return to the front waits like the app-wide clear, so a tap on one of
 * them is not lost.
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
