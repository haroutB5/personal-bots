/**
 * A notification tap iOS never dispatched, found by asking the server.
 *
 * Everything on the phone has failed at this. On 1 Oct an Assistant reply was
 * pushed at 07:16:59 and tapped; at the 07:18:46 resume the worker's list of
 * shown notifications and getNotifications() both came back empty, while
 * fresh launches saw them (shown 6-7, listed 9). The server keeps its own
 * record of every push it delivered to each device (the outbox), and iOS
 * cannot lose that. So when the app comes back without a tap, the page asks
 * the server what it sent to this device while the app was away (at most two
 * minutes back; see apps/server personal/push/sentPushesRoute.ts). If every
 * push opens one place, that is where the tap meant to go. The phone's own
 * list (lostNotificationTaps.ts) is asked only when the server cannot answer.
 */
import { findLostTap, type NotificationLister } from "./lostNotificationTaps";
import { isNavigablePath, type LostTapLook } from "./notificationTap";

/** Must match PERSONAL_PUSH_SENT_PATH in apps/server personal/push/sentPushesRoute.ts. */
export const PUSH_SENT_URL = "/api/personal/push/sent";
/** Where the device's push endpoint is kept, for a resume where iOS will not say it. */
export const PUSH_ENDPOINT_KEY = "bots:push-endpoint";
/** How long the page waits for the server before trying the phone's own list. */
export const SERVER_LOST_TAP_TIMEOUT_MS = 4_000;

export interface SentPush {
  readonly url: string;
  readonly sentAt: string;
}

export interface ServerLostTapLook extends LostTapLook {
  readonly store: "server";
  /** Pushes the server sent this device in the window. */
  readonly sent: number;
}

/**
 * What the server's answer means: the one place every push opens, or why
 * there is none. Null when the server does not know this device.
 */
export function decideServerLostTap(answer: unknown): ServerLostTapLook | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { known, pushes } = answer as { known?: unknown; pushes?: unknown };
  if (known !== true || !Array.isArray(pushes)) return null;
  const urls = new Set(
    pushes.flatMap((push: unknown) => {
      const url = typeof push === "object" && push !== null ? (push as SentPush).url : null;
      return isNavigablePath(url) ? [url] : [];
    }),
  );
  const sent = pushes.length;
  if (urls.size === 0) return { url: null, reason: "none-sent", store: "server", sent };
  if (urls.size > 1) return { url: null, reason: "several-sent", store: "server", sent };
  return { url: [...urls][0]!, reason: "server-sent", store: "server", sent };
}

export interface PushEndpointSource {
  readonly pushManager?: { readonly getSubscription: () => Promise<{ endpoint: string } | null> };
}

export interface EndpointMemory {
  readonly read: () => string | null;
  readonly write: (endpoint: string) => void;
}

/** localStorage, best-effort. */
export const localEndpointMemory: EndpointMemory = {
  read: () => {
    try {
      return window.localStorage.getItem(PUSH_ENDPOINT_KEY);
    } catch {
      return null;
    }
  },
  write: (endpoint) => {
    try {
      window.localStorage.setItem(PUSH_ENDPOINT_KEY, endpoint);
    } catch {
      // The next fresh launch asks iOS again.
    }
  },
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * This device's push endpoint: from the browser when it answers (and kept
 * for later), else the one kept from an earlier launch.
 */
export async function currentPushEndpoint(
  registration: PushEndpointSource | null,
  memory: EndpointMemory = localEndpointMemory,
): Promise<string | null> {
  const subscription =
    registration?.pushManager === undefined
      ? null
      : await withTimeout(registration.pushManager.getSubscription(), 1_500);
  if (subscription !== null && typeof subscription.endpoint === "string") {
    memory.write(subscription.endpoint);
    return subscription.endpoint;
  }
  return memory.read();
}

export type ServerLostTapOutcome =
  | { readonly answered: true; readonly look: ServerLostTapLook }
  | { readonly answered: false; readonly reason: string };

/** Asks the server what it sent this device while the app was away. */
export async function askServerForLostTap(input: {
  readonly endpoint: string | null;
  /** How long the app was away; null when not known (a launch with no record). */
  readonly awayMs: number | null;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<ServerLostTapOutcome> {
  if (input.endpoint === null) return { answered: false, reason: "no-endpoint" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? SERVER_LOST_TAP_TIMEOUT_MS);
  try {
    const response = await input.fetch(PUSH_SENT_URL, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: input.endpoint, awayMs: input.awayMs }),
      signal: controller.signal,
    });
    if (!response.ok) return { answered: false, reason: `http-${response.status}` };
    const look = decideServerLostTap(await response.json());
    return look === null ? { answered: false, reason: "unknown-device" } : { answered: true, look };
  } catch {
    return { answered: false, reason: controller.signal.aborted ? "timeout" : "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The look the page logs and acts on: the server's, whenever it answers for
 * this device, else the phone's own list, noting why the server did not.
 */
export async function findLostTapServerFirst(input: {
  readonly server: () => Promise<ServerLostTapOutcome>;
  readonly phone: () => Promise<LostTapLook>;
}): Promise<LostTapLook & { readonly server?: string }> {
  const server = await input
    .server()
    .catch((): ServerLostTapOutcome => ({ answered: false, reason: "failed" }));
  if (server.answered) return server.look;
  const phone = await input.phone();
  return { ...phone, server: server.reason };
}

/**
 * The page's lost-tap look (notificationTap.ts lostTap.find): the server's
 * record of what it sent this device first, the phone's own list second.
 */
export function makeLostTapFinder(deps: {
  readonly registration: () => Promise<(PushEndpointSource & NotificationLister) | null>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly memory?: EndpointMemory;
}): (context: { readonly awaySince: number }) => Promise<LostTapLook> {
  return ({ awaySince }) =>
    findLostTapServerFirst({
      server: async () =>
        askServerForLostTap({
          endpoint: await currentPushEndpoint(await deps.registration(), deps.memory),
          awayMs: awaySince === 0 ? null : Math.max(0, deps.now() - awaySince),
          fetch: deps.fetch,
        }),
      phone: async () => findLostTap(await deps.registration(), { awaySince }),
    });
}
