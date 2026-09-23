import type { PersonalPushInAppNotification } from "@t3tools/contracts";

/** How long a banner stays up on its own. */
export const IN_APP_BANNER_MS = 6_000;
/**
 * "The app is on screen" heartbeat. The server counts a report for 20 s, so
 * one lost heartbeat does not flip notifications back to web push.
 */
export const FOREGROUND_HEARTBEAT_MS = 10_000;
/** Upward drag, in px, that dismisses the banner instead of opening it. */
export const IN_APP_SWIPE_DISMISS_PX = 24;

export interface InAppPlan {
  /** Ids to acknowledge: the page took them, so the server sends no push. */
  readonly ack: ReadonlyArray<string>;
  /** The banner to show now (the newest new one), or null. */
  readonly show: PersonalPushInAppNotification | null;
}

/**
 * What to do with the in-app feed after it changed. Every id is handled once
 * (`seen` is updated in place). A hidden page acknowledges nothing, so the
 * server falls back to web push for it. A visible page acknowledges each new
 * notification, and shows the newest one unless it points at the screen
 * already open.
 */
export function planInAppNotifications(
  seen: Set<string>,
  feed: ReadonlyArray<PersonalPushInAppNotification>,
  page: { readonly visible: boolean; readonly currentPath: string },
): InAppPlan {
  const fresh = feed.filter((notification) => !seen.has(notification.id));
  for (const notification of fresh) seen.add(notification.id);
  if (!page.visible || fresh.length === 0) return { ack: [], show: null };
  const shown = fresh.filter((notification) => notification.url !== page.currentPath);
  return { ack: fresh.map((notification) => notification.id), show: shown.at(-1) ?? null };
}
