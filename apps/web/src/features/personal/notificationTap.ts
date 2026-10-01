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
 * When the app comes back and no tap arrives at all, a tap iOS never handed to
 * the worker is looked for (see lostNotificationTaps.ts).
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
  | "cache-load"
  | "inferred";

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
  /**
   * Finds a tap that reached no route (lostNotificationTaps.ts), run `after`
   * a grace period on each return to the app. `find` gets when the app last
   * went to the background (0 if it has not since launch) and returns the
   * deep link to open, or null, plus why, for the lost-tap-check line.
   */
  /**
   * Where the last move to the background is kept across launches, so a cold
   * launch after iOS ended the app still knows when it went away.
   */
  readonly awayStore?: {
    readonly read: () => number;
    readonly write: (at: number) => void;
  };
  readonly lostTap?: {
    /**
     * Asks the server, at once on each return, what it sent this device
     * while the app was away (serverLostTap.ts). An answer decides; no answer
     * falls back to `find` after the grace period.
     */
    readonly ask?: (context: { readonly awaySince: number }) => Promise<LostTapAnswer>;
    readonly find: (context: { readonly awaySince: number }) => Promise<LostTapLook>;
    readonly after: (callback: () => void, ms: number) => void;
    /** A tap inferred and about to open `url`, `sinceReturnMs` after the return (timings). */
    readonly onInferred?: (url: string, sinceReturnMs: number) => void;
  };
}

/** The server's answer, or why there is none (the phone's list decides then). */
export type LostTapAnswer =
  | { readonly answered: true; readonly look: LostTapLook }
  | { readonly answered: false; readonly reason: string };

/** What a look found; any further fields (counts) go into its log line as they are. */
export interface LostTapLook {
  readonly url: string | null;
  readonly reason: string;
  /** Why the server did not answer, when the phone's own list decided. */
  readonly server?: string;
}

/** How long the page watches for a tap after a push was shown. */
export const TAP_WATCH_AFTER_PUSH_MS = 60_000;
/** How long it watches after the app comes back (the worker may write late). */
export const TAP_WATCH_AFTER_RESUME_MS = 10_000;
export const TAP_POLL_INTERVAL_MS = 750;
const HANDLED_IDS_MAX = 50;
/**
 * How long the page waits after coming back for a real tap before it looks
 * for a lost one (lostNotificationTaps.ts). A delivered click reaches a waking
 * page within about a second in the server logs.
 */
export const LOST_TAP_GRACE_MS = 2_500;

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
  /** The app went to the background: notifications after this are news to it. */
  readonly away: () => void;
  readonly dispose: () => void;
}

export function createNotificationTapController(
  deps: NotificationTapDeps,
): NotificationTapController {
  const handled: string[] = [];
  let watchUntil = 0;
  let watchStartedBy: string | null = null;
  let timer: unknown = null;
  // Bumped by every delivered tap, so a lost-tap look knows one arrived.
  let deliveries = 0;
  let lookingForLostTap = false;
  let awaySince = (() => {
    try {
      const at = deps.awayStore?.read() ?? 0;
      return Number.isFinite(at) && at > 0 ? at : 0;
    } catch {
      return 0;
    }
  })();

  const deliver = (url: string, id: string | null, via: TapRoute): void => {
    deliveries += 1;
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

  const lookForLostTap = (via: TapRoute) => {
    const lostTap = deps.lostTap;
    if (lostTap === undefined || lookingForLostTap) return;
    lookingForLostTap = true;
    const before = deliveries;
    const returnedAt = deps.now();
    const pathAtReturn = deps.currentPath();
    const context = { awaySince };

    const settle = (look: LostTapLook, timings: Record<string, number | undefined>) => {
      lookingForLostTap = false;
      const url = look.url !== null && isNavigablePath(look.url) ? look.url : null;
      const path = deps.currentPath();
      // A real tap landed meanwhile: it wins. The look still ran, so the
      // list forgets the notification that tap removed. A user who has
      // moved on since the return is not pulled back.
      const outcome =
        deliveries !== before
          ? "tap-arrived"
          : url === null
            ? "none"
            : path !== pathAtReturn && path !== url
              ? "user-moved"
              : "opened";
      const waitedMs = Math.max(0, deps.now() - returnedAt);
      // Every look, so a tap that still goes nowhere shows why.
      deps.report?.({
        ...look,
        ...timings,
        event: "lost-tap-check",
        via,
        url: url ?? undefined,
        outcome,
        waitedMs,
        awayMs: awaySince === 0 ? undefined : Math.max(0, returnedAt - awaySince),
      });
      if (outcome === "opened") {
        lostTap.onInferred?.(url!, waitedMs);
        deliver(url!, null, "inferred");
      }
    };

    // The phone's own list, after the grace period: a tap the worker did see
    // must have taken its notification off the list first.
    const phone = (server: string | undefined, timings: Record<string, number | undefined>) => {
      lostTap.after(
        () => {
          void lostTap
            .find(context)
            .catch((): LostTapLook => ({ url: null, reason: "failed" }))
            .then((look) => settle(server === undefined ? look : { ...look, server }, timings));
        },
        Math.max(0, LOST_TAP_GRACE_MS - (deps.now() - returnedAt)),
      );
    };

    const ask = lostTap.ask;
    if (ask === undefined) {
      phone(undefined, {});
      return;
    }
    // The server is asked at once, alongside any real tap still on its way:
    // its answer opens the chat as soon as it arrives (1.60.12 waited the
    // whole grace period first: 2.5 s of the 2.6 s on the phone). A real tap
    // that lands first wins; one that lands after for the same chat changes
    // nothing, since the page is already there.
    const asked = deps.now();
    void ask(context)
      .catch((): LostTapAnswer => ({ answered: false, reason: "failed" }))
      .then((answer) => {
        const timings = { requestMs: Math.max(0, deps.now() - asked) };
        if (answer.answered) settle(answer.look, timings);
        else phone(answer.reason, timings);
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
      // A return to the app or a launch, not a mere focus change.
      if (via === "cache-visible" || via === "cache-pageshow" || via === "cache-load") {
        lookForLostTap(via);
      }
      await check(via);
    },
    watch: (ms) => startWatch(ms, "manual"),
    away: () => {
      awaySince = deps.now();
      try {
        deps.awayStore?.write(awaySince);
      } catch {
        // Storage refused: this launch still knows; the next one starts at 0.
      }
    },
    dispose: stop,
  };
}
