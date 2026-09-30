/**
 * Notification taps iOS never hands to the worker.
 *
 * On 30 Sep (17:49) an Assistant task notification was tapped while the
 * installed app sat suspended on CTO's chat. iOS brought the app to the front
 * and removed the notification, but dispatched no notificationclick: the
 * server log has no notificationclick-start line, no worker request at all,
 * and the page simply resumed on the chat it was left on. WebKit has known
 * gaps here for Home Screen apps that are already running.
 *
 * So the worker also keeps a short list of the notifications it has shown
 * (public/sw.js, SHOWN_CACHE). A tap it does see, a dismissal it is told
 * about and a close from the page each take the entry off the list. When the
 * app comes back without a delivered tap, the page compares the list with
 * what is still in Notification Center: exactly one missing entry is the one
 * the user tapped. None missing (opened from the icon) or several (Clear All)
 * opens nothing.
 */
import { isNavigablePath } from "./notificationTap";

export { LOST_TAP_GRACE_MS } from "./notificationTap";

/** Must match SHOWN_CACHE / SHOWN_KEY in public/sw.js. */
export const SHOWN_CACHE = "bots-shown-notifications";
export const SHOWN_KEY = "/__bots-shown__";
/** A notification older than this is not what the user is opening the app for. */
export const SHOWN_NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60_000;

export interface ShownNotification {
  /** The notification's tag, or its url when it has none. */
  readonly key: string;
  readonly url: string;
  readonly at: number;
}

export interface ListedNotification {
  readonly tag?: string;
  readonly data?: unknown;
}

/** The key the worker filed a notification under: its tag, else its url. */
export function listedNotificationKey(notification: ListedNotification): string | null {
  if (typeof notification.tag === "string" && notification.tag.length > 0) return notification.tag;
  const data = notification.data;
  if (typeof data !== "object" || data === null) return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

function parseShown(raw: unknown): ShownNotification[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { key, url, at } = entry as { key?: unknown; url?: unknown; at?: unknown };
    return typeof key === "string" && typeof url === "string" && typeof at === "number"
      ? [{ key, url, at }]
      : [];
  });
}

/**
 * Splits the list into what is still shown and the one entry that left
 * Notification Center, when exactly one fresh, openable entry did.
 */
export function reconcileShown(
  entries: ReadonlyArray<ShownNotification>,
  presentKeys: ReadonlyArray<string>,
  now: number,
): { readonly kept: ShownNotification[]; readonly tapped: ShownNotification | null } {
  const present = new Set(presentKeys);
  const fresh = entries.filter(
    (entry) => now - entry.at >= 0 && now - entry.at < SHOWN_NOTIFICATIONS_MAX_AGE_MS,
  );
  const kept = fresh.filter((entry) => present.has(entry.key));
  const gone = fresh.filter((entry) => !present.has(entry.key));
  const only = gone.length === 1 ? gone[0]! : null;
  return { kept, tapped: only !== null && isNavigablePath(only.url) ? only : null };
}

type CacheLike = Pick<Cache, "match" | "put">;

async function openShownCache(): Promise<CacheLike | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(SHOWN_CACHE);
  } catch {
    return null;
  }
}

async function readShown(cache: CacheLike): Promise<ShownNotification[]> {
  const response = await cache.match(SHOWN_KEY);
  return response === undefined ? [] : parseShown(await response.json());
}

async function writeShown(cache: CacheLike, entries: ReadonlyArray<ShownNotification>) {
  await cache.put(SHOWN_KEY, new Response(JSON.stringify(entries)));
}

export interface NotificationLister {
  readonly getNotifications?: () => Promise<ReadonlyArray<ListedNotification>>;
}

/**
 * Reconciles the worker's list with Notification Center and returns the url
 * of the notification that was tapped without a click, or null. Anything
 * unavailable (no worker, no getNotifications, storage refused) finds none.
 */
export async function findLostTap(
  source: NotificationLister | null,
  now: number = Date.now(),
): Promise<string | null> {
  if (source == null || typeof source.getNotifications !== "function") return null;
  const cache = await openShownCache();
  if (cache === null) return null;
  try {
    const entries = await readShown(cache);
    if (entries.length === 0) return null;
    const listed = await source.getNotifications();
    const presentKeys = listed.flatMap((notification) => {
      const key = listedNotificationKey(notification);
      return key === null ? [] : [key];
    });
    const { kept, tapped } = reconcileShown(entries, presentKeys, now);
    await writeShown(cache, kept);
    return tapped?.url ?? null;
  } catch {
    return null;
  }
}

/** Takes notifications the page closed off the list: they were not tapped. */
export async function forgetShownNotifications(keys: ReadonlyArray<string>): Promise<void> {
  if (keys.length === 0) return;
  const cache = await openShownCache();
  if (cache === null) return;
  try {
    const gone = new Set(keys);
    const entries = await readShown(cache);
    const kept = entries.filter((entry) => !gone.has(entry.key));
    if (kept.length !== entries.length) await writeShown(cache, kept);
  } catch {
    // The entry ages out; worst case it is never guessed (several gone at once).
  }
}
