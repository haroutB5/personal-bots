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
 * That alone never fired on the phone, and what Notification Center reports
 * is not dependable either: the 24-26 Sep resume cleanups found the
 * just-tapped notification still listed (closed:1), while on 30 Sep at 22:16
 * getNotifications() listed none with two on the list. So a notification
 * shown in the last RECENT_TAP_WINDOW_MS, while the app was away, is also
 * taken as the tap, if every such notification opens one place. Several
 * places, or only older ones, open nothing. The cost: opening the app from
 * its icon within that window after a banner also opens the banner's chat.
 *
 * The list itself is read through the worker (see "Where the list is read"
 * below): the page's own view of it went stale on iOS.
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
/**
 * The one notification that left Notification Center is taken as the tap
 * only if it was shown during this away period and at most this long ago:
 * iOS does not reliably tell the worker about swipe-aways, so an old swiped
 * notification must not take over a later launch (QA 1 Oct 00:42, opened a
 * gone entry 137 s old on a cold relaunch with no away limit).
 */
export const GONE_TAP_MAX_AGE_MS = 15 * 60_000;

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
  | "gone-too-old"
  | "gone-before-away"
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
  const onlyGone = gone.length === 1 ? gone[0]! : null;
  if (onlyGone !== null && onlyGone.at >= awaySince && now - onlyGone.at <= GONE_TAP_MAX_AGE_MS) {
    return pick(onlyGone, "one-gone");
  }
  // Several gone (Clear All, or iOS listing none: 22:16 had listed 0 with two
  // on the list) says nothing on its own; only a recent one can still tell.
  if (recent.length === 0) {
    const reason: LostTapReason =
      onlyGone === null
        ? gone.length > 1
          ? "several-gone"
          : "none-recent"
        : onlyGone.at < awaySince
          ? "gone-before-away"
          : "gone-too-old";
    return { tapped: null, reason, ...counts };
  }
  if (new Set(recent.map((entry) => entry.url)).size > 1) {
    return { tapped: null, reason: "several-recent", ...counts };
  }
  return pick(recent.at(-1)!, "recent");
}

/*
 * Where the list is read and trimmed.
 *
 * The worker writes the list, and on iOS a page that was already running when
 * it wrote does not see the write in its own Cache Storage: on 30 Sep the
 * resumed page read an empty list at 21:34 and at 22:37:57, two seconds after
 * the worker had recorded the tapped notification (push-shown 22:37:55),
 * while a page loaded fresh at 22:16 read both entries still there. So the
 * page asks the worker, which reads its own writes, and uses Cache Storage
 * directly only when no worker answers.
 */

/** Messages for the worker's list. Must match public/sw.js. */
export const SHOWN_READ_MESSAGE = "bots:shown-read";
export const SHOWN_FORGET_MESSAGE = "bots:shown-forget";
/** How long the page waits for the worker before it reads Cache Storage itself. */
export const SHOWN_WORKER_TIMEOUT_MS = 3_000;

export interface ForgetShown {
  readonly key: string;
  readonly at: number;
}

/** Entries left after `gone`. Must match forgetEntries in public/sw.js. */
export function withoutForgotten(
  entries: ReadonlyArray<ShownNotification>,
  gone: ReadonlyArray<ForgetShown>,
): ShownNotification[] {
  return entries.filter((entry) => !gone.some((g) => g.key === entry.key && entry.at <= g.at));
}

export interface ShownStore {
  /** "worker" or "cache", for the log line: which one answered. */
  readonly read: () => Promise<{ readonly entries: ShownNotification[]; readonly via: string }>;
  /** Drops each entry under `key` recorded at or before `at`; a newer one for the same key stays. */
  readonly forget: (gone: ReadonlyArray<ForgetShown>) => Promise<void>;
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

/** The list straight from this page's Cache Storage (may be stale on iOS). */
export const cacheShownStore: ShownStore = {
  read: async () => {
    const cache = await openShownCache();
    if (cache === null) throw new Error("no-storage");
    return { entries: await readShown(cache), via: "cache" };
  },
  forget: async (gone) => {
    const cache = await openShownCache();
    if (cache === null) return;
    const entries = await readShown(cache);
    const kept = withoutForgotten(entries, gone);
    if (kept.length !== entries.length) {
      await cache.put(SHOWN_KEY, new Response(JSON.stringify(kept)));
    }
  },
};

export interface WorkerLike {
  readonly postMessage: (message: unknown, transfer: Transferable[]) => void;
}

/** Sends one request to the worker and resolves with its answer, or rejects. */
function askWorker(worker: WorkerLike, message: object, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("worker-timeout"));
    }, timeoutMs);
    channel.port1.addEventListener("message", (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data);
    });
    channel.port1.start();
    try {
      worker.postMessage(message, [channel.port2]);
    } catch (error) {
      clearTimeout(timer);
      channel.port1.close();
      reject(error);
    }
  });
}

/** Asks `worker` for the list; falls back to Cache Storage if it does not answer. */
export function workerShownStore(
  worker: WorkerLike,
  timeoutMs: number = SHOWN_WORKER_TIMEOUT_MS,
): ShownStore {
  return {
    read: async () => {
      try {
        const answer = (await askWorker(worker, { type: SHOWN_READ_MESSAGE }, timeoutMs)) as {
          entries?: unknown;
        } | null;
        if (answer !== null && typeof answer === "object" && Array.isArray(answer.entries)) {
          return { entries: parseShown(answer.entries), via: "worker" };
        }
      } catch {
        // Fall through to the page's own view.
      }
      const fallback = await cacheShownStore.read();
      return { entries: fallback.entries, via: "cache-fallback" };
    },
    forget: async (gone) => {
      try {
        await askWorker(worker, { type: SHOWN_FORGET_MESSAGE, gone }, timeoutMs);
      } catch {
        await cacheShownStore.forget(gone);
      }
    },
  };
}

/** The worker controlling this page when there is one, else Cache Storage. */
export function defaultShownStore(): ShownStore {
  const worker =
    typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker.controller
      : null;
  return worker ? workerShownStore(worker) : cacheShownStore;
}

export interface NotificationLister {
  readonly getNotifications?: () => Promise<ReadonlyArray<ListedNotification>>;
}

export interface LostTapResult extends Omit<LostTapDecision, "tapped"> {
  /** The deep link to open, or null. */
  readonly url: string | null;
  /** Notifications Notification Center listed; null when it could not be read. */
  readonly listed: number | null;
  /** Which store answered: worker, cache-fallback or cache. */
  readonly store: string | null;
}

function noLostTap(reason: LostTapReason, store: string | null): LostTapResult {
  return { url: null, reason, shown: 0, listed: null, gone: 0, recent: 0, store };
}

/**
 * Looks for the notification tapped without a click and says what it found
 * and why. The entry chosen, and every entry Notification Center no longer
 * lists, leave the list, so the same notification is never opened twice.
 * Without a worker or getNotifications only the recent rule can apply.
 */
export async function findLostTap(
  source: NotificationLister | null,
  options: {
    readonly now?: number;
    readonly awaySince?: number;
    readonly store?: ShownStore;
  } = {},
): Promise<LostTapResult> {
  const now = options.now ?? Date.now();
  const store = options.store ?? defaultShownStore();
  let entries: ShownNotification[];
  let via: string;
  try {
    ({ entries, via } = await store.read());
  } catch (error) {
    return noLostTap(
      error instanceof Error && error.message === "no-storage" ? "no-storage" : "failed",
      null,
    );
  }
  if (entries.length === 0) return noLostTap("none-shown", via);
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
  const dropped = entries.filter(
    (entry) => entry === tapped || (present !== null && !present.has(entry.key)),
  );
  try {
    if (dropped.length > 0) await store.forget(dropped.map(({ key, at }) => ({ key, at })));
  } catch {
    // Worst case the same entry is considered again on the next return.
  }
  return {
    ...decision,
    url: tapped?.url ?? null,
    listed: listed === null ? null : listed.length,
    store: via,
  };
}

/** Takes notifications the page closed off the list: they were not tapped. */
export async function forgetShownNotifications(
  keys: ReadonlyArray<string>,
  store: ShownStore = defaultShownStore(),
): Promise<void> {
  if (keys.length === 0) return;
  try {
    const at = Date.now();
    await store.forget(keys.map((key) => ({ key, at })));
  } catch {
    // The entry ages out; worst case it is never guessed (several gone at once).
  }
}
