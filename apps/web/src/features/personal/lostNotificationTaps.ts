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
 * the user tapped.
 *
 * That alone never fired on the phone. On 30 Sep (21:33, live 1.60.8) the
 * tapped Assistant notification was not missing: when iOS drops the click it
 * also leaves the notification in getNotifications() (the resume cleanups of
 * 24-26 Sep found and closed exactly the just-tapped one, closed:1). So when
 * nothing is missing, a notification shown in the last RECENT_TAP_WINDOW_MS,
 * while the app was away, is taken as the tap, if every such notification
 * opens one place. Several places, several missing, or only older ones open
 * nothing. The cost: opening the app from its icon within that window after a
 * banner also opens the banner's chat.
 *
 * Every look reports its decision (lost-tap-check in the server log), so a
 * tap that still goes nowhere shows why.
 */
import { isNavigablePath } from "./notificationTap";

export { LOST_TAP_GRACE_MS } from "./notificationTap";

/** Must match SHOWN_CACHE / SHOWN_KEY in public/sw.js. */
export const SHOWN_CACHE = "bots-shown-notifications";
export const SHOWN_KEY = "/__bots-shown__";
/** A notification older than this is not what the user is opening the app for. */
export const SHOWN_NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * A notification shown this recently, while the app was away, is taken as
 * the one tapped when none has left Notification Center.
 */
export const RECENT_TAP_WINDOW_MS = 2 * 60_000;

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

export type LostTapReason =
  | "one-gone"
  | "recent"
  | "none-shown"
  | "several-gone"
  | "none-recent"
  | "several-recent"
  | "not-openable"
  | "no-storage"
  | "failed";

export interface LostTapDecision {
  readonly tapped: ShownNotification | null;
  readonly reason: LostTapReason;
  /** Fresh entries on the worker's list. */
  readonly shown: number;
  /** Of those, how many left Notification Center. */
  readonly gone: number;
  /** Of those, how many were shown within the window while the app was away. */
  readonly recent: number;
}

/**
 * Picks the notification the user tapped, if one can be told apart: the one
 * entry that left Notification Center, else the one place every recent entry
 * opens. `presentKeys` null means Notification Center could not be read.
 * `awaySince` is when the app last went to the background (0 on a launch).
 */
export function decideLostTap(
  entries: ReadonlyArray<ShownNotification>,
  presentKeys: ReadonlyArray<string> | null,
  now: number,
  awaySince: number,
): LostTapDecision {
  const fresh = entries.filter(
    (entry) => now - entry.at >= 0 && now - entry.at < SHOWN_NOTIFICATIONS_MAX_AGE_MS,
  );
  const present = presentKeys === null ? null : new Set(presentKeys);
  const gone = present === null ? [] : fresh.filter((entry) => !present.has(entry.key));
  const recent = fresh.filter(
    (entry) => entry.at >= awaySince && now - entry.at <= RECENT_TAP_WINDOW_MS,
  );
  const counts = { shown: fresh.length, gone: gone.length, recent: recent.length };
  const pick = (entry: ShownNotification, reason: LostTapReason): LostTapDecision =>
    isNavigablePath(entry.url)
      ? { tapped: entry, reason, ...counts }
      : { tapped: null, reason: "not-openable", ...counts };
  if (fresh.length === 0) return { tapped: null, reason: "none-shown", ...counts };
  if (gone.length === 1) return pick(gone[0]!, "one-gone");
  // Clear All, or several swiped away unseen: no way to tell which was tapped.
  if (gone.length > 1) return { tapped: null, reason: "several-gone", ...counts };
  if (recent.length === 0) return { tapped: null, reason: "none-recent", ...counts };
  if (new Set(recent.map((entry) => entry.url)).size > 1) {
    return { tapped: null, reason: "several-recent", ...counts };
  }
  return pick(recent.at(-1)!, "recent");
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

export interface LostTapResult extends Omit<LostTapDecision, "tapped"> {
  /** The deep link to open, or null. */
  readonly url: string | null;
  /** Notifications Notification Center listed; null when it could not be read. */
  readonly listed: number | null;
}

function noLostTap(reason: LostTapReason): LostTapResult {
  return { url: null, reason, shown: 0, listed: null, gone: 0, recent: 0 };
}

/**
 * Looks for the notification tapped without a click and says what it found
 * and why. The entry chosen, and every entry Notification Center no longer
 * lists, leave the list, so the same notification is never opened twice.
 * Without a worker or getNotifications only the recent rule can apply.
 */
export async function findLostTap(
  source: NotificationLister | null,
  options: { readonly now?: number; readonly awaySince?: number } = {},
): Promise<LostTapResult> {
  const now = options.now ?? Date.now();
  const cache = await openShownCache();
  if (cache === null) return noLostTap("no-storage");
  let entries: ShownNotification[];
  try {
    entries = await readShown(cache);
  } catch {
    return noLostTap("failed");
  }
  if (entries.length === 0) return noLostTap("none-shown");
  let listed: ReadonlyArray<ListedNotification> | null = null;
  if (source != null && typeof source.getNotifications === "function") {
    try {
      listed = await source.getNotifications();
    } catch {
      listed = null;
    }
  }
  const presentKeys =
    listed === null
      ? null
      : listed.flatMap((notification) => {
          const key = listedNotificationKey(notification);
          return key === null ? [] : [key];
        });
  const { tapped, ...decision } = decideLostTap(entries, presentKeys, now, options.awaySince ?? 0);
  const present = presentKeys === null ? null : new Set(presentKeys);
  const kept = entries.filter(
    (entry) =>
      now - entry.at < SHOWN_NOTIFICATIONS_MAX_AGE_MS &&
      entry !== tapped &&
      (present === null || present.has(entry.key)),
  );
  try {
    if (kept.length !== entries.length) await writeShown(cache, kept);
  } catch {
    // Worst case the same entry is considered again on the next return.
  }
  return { ...decision, url: tapped?.url ?? null, listed: listed === null ? null : listed.length };
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
