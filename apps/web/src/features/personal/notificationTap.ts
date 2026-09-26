/**
 * Page side of a notification tap: turns whatever route the deep link arrives
 * by into exactly one navigation.
 *
 * The service worker sends each tap three ways at once (see public/sw.js): a
 * postMessage to every open window, a BroadcastChannel message, and a saved
 * copy in Cache Storage. On iOS each route alone has been seen to fail, and an
 * app that is already in the foreground gets no visibility or focus event
 * when its banner is tapped. So besides the two messages, the page reads the
 * saved copy when it becomes visible or gains focus, and polls it for a short
 * while after the worker says a notification was shown or the app came back.
 */

export interface PendingTap {
  readonly url: string;
  /** Tap id from the worker; null for a copy saved by an older worker. */
  readonly id: string | null;
}

export type TapRoute =
  | "message"
  | "broadcast"
  | "cache-visible"
  | "cache-focus"
  | "cache-pageshow"
  | "cache-poll"
  | "cache-load";

export interface TapAck {
  readonly type: "bots:navigate-ack";
  readonly id: string;
  readonly via: TapRoute;
  readonly visibility: string;
}

export interface NotificationTapDeps {
  readonly navigate: (path: string) => void;
  readonly currentPath: () => string;
  readonly takePending: () => Promise<PendingTap | null>;
  readonly isVisible: () => boolean;
  readonly visibility: () => string;
  readonly now: () => number;
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  /** Tells the worker the tap landed, so it does not navigate the window itself. */
  readonly ack: (ack: TapAck) => void;
  /** One line per delivered tap for the server log; best-effort. */
  readonly report?: (record: Record<string, unknown>) => void;
}

/** How long the page watches for a tap after a push was shown. */
export const TAP_WATCH_AFTER_PUSH_MS = 60_000;
/** How long it watches after the app comes back (the worker may write late). */
export const TAP_WATCH_AFTER_RESUME_MS = 10_000;
export const TAP_POLL_INTERVAL_MS = 750;
const HANDLED_IDS_MAX = 50;

/** Deep links the worker may ask the page to open: same-origin paths only. */
export function isNavigablePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 32)
  );
}

export interface NotificationTapController {
  /** A message from the worker or the BroadcastChannel. */
  readonly onMessage: (data: unknown, via: "message" | "broadcast") => void;
  /** Reads the saved copy once (visible, focus, pageshow, first load). */
  readonly check: (via: TapRoute) => Promise<void>;
  /** Polls the saved copy while visible until `ms` from now. */
  readonly watch: (ms: number) => void;
  readonly dispose: () => void;
}

export function createNotificationTapController(
  deps: NotificationTapDeps,
): NotificationTapController {
  const handled: string[] = [];
  let watchUntil = 0;
  let watchStartedBy: string | null = null;
  let timer: unknown = null;

  const deliver = (url: string, id: string | null, via: TapRoute): void => {
    if (id !== null) {
      if (handled.includes(id)) return;
      handled.push(id);
      if (handled.length > HANDLED_IDS_MAX) handled.shift();
      deps.ack({ type: "bots:navigate-ack", id, via, visibility: deps.visibility() });
    }
    const from = deps.currentPath();
    if (from !== url) deps.navigate(url);
    deps.report?.({
      event: "tap-received",
      id,
      url,
      via,
      visibility: deps.visibility(),
      navigated: from !== url,
      watching: watchStartedBy,
    });
  };

  const check = async (via: TapRoute): Promise<void> => {
    const pending = await deps.takePending().catch(() => null);
    if (pending !== null) deliver(pending.url, pending.id, via);
  };

  const stop = () => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
    watchStartedBy = null;
  };

  const tick = () => {
    if (deps.now() >= watchUntil) {
      stop();
      return;
    }
    // A hidden page cannot be what the user tapped into; it gets the copy on resume.
    if (deps.isVisible()) void check("cache-poll");
  };

  const startWatch = (ms: number, reason: string) => {
    watchUntil = Math.max(watchUntil, deps.now() + ms);
    if (timer === null) {
      watchStartedBy = reason;
      timer = deps.setInterval(tick, TAP_POLL_INTERVAL_MS);
    }
  };

  return {
    onMessage: (data, via) => {
      if (typeof data !== "object" || data === null) return;
      const message = data as { type?: unknown; url?: unknown; id?: unknown };
      if (message.type === "bots:push-shown") {
        startWatch(TAP_WATCH_AFTER_PUSH_MS, "push-shown");
        return;
      }
      if (message.type !== "bots:navigate" || !isNavigablePath(message.url)) return;
      const id = typeof message.id === "string" && message.id.length > 0 ? message.id : null;
      deliver(message.url, id, via);
      // Clear the saved copy: same id is a no-op, a newer tap still lands.
      void check("cache-poll");
    },
    check: async (via) => {
      if (via === "cache-visible" || via === "cache-focus" || via === "cache-pageshow") {
        startWatch(TAP_WATCH_AFTER_RESUME_MS, via);
      }
      await check(via);
    },
    watch: (ms) => startWatch(ms, "manual"),
    dispose: stop,
  };
}
