import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";

import { runningClientEntry } from "./appVersion";
import {
  createNotificationTapController,
  isNavigablePath,
  type PendingTap,
} from "./notificationTap";

export interface ServiceWorkerEnvironment {
  readonly production: boolean;
  readonly secureContext: boolean;
  readonly electron: boolean;
  readonly supported: boolean;
}

/** The worker only runs in production builds on secure origins, never in Electron. */
export function shouldRegisterServiceWorker(environment: ServiceWorkerEnvironment): boolean {
  return (
    environment.production &&
    environment.secureContext &&
    !environment.electron &&
    environment.supported
  );
}

export { isNavigablePath };

/** Must match PENDING_NAV_CACHE / PENDING_NAV_KEY / NAV_CHANNEL / DIAG_URL in public/sw.js. */
const PENDING_NAV_CACHE = "bots-pending-nav";
const PENDING_NAV_KEY = "/__bots-pending-nav__";
const NAV_CHANNEL = "bots-nav";
const DIAG_URL = "/api/personal/client-diag";
/** An older tap is not what the user is opening the app for now. */
const PENDING_NAV_MAX_AGE_MS = 2 * 60_000;
/** Resuming the app also asks the browser to look for a newer worker, at most this often. */
const WORKER_UPDATE_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Takes (and clears) the deep link the worker saved for the last notification
 * tap, or null when there is none, it is stale or it is not a safe path.
 */
export async function takePendingTap(now: number = Date.now()): Promise<PendingTap | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(PENDING_NAV_CACHE);
    const response = await cache.match(PENDING_NAV_KEY);
    if (response === undefined) return null;
    await cache.delete(PENDING_NAV_KEY);
    const data = (await response.json()) as { url?: unknown; at?: unknown; id?: unknown } | null;
    const fresh = typeof data?.at === "number" && now - data.at < PENDING_NAV_MAX_AGE_MS;
    if (!fresh || !isNavigablePath(data?.url)) return null;
    const id = typeof data?.id === "string" && data.id.length > 0 ? data.id : null;
    return { url: data.url, id };
  } catch {
    return null;
  }
}

/** takePendingTap, deep link only. */
export async function takePendingNavigation(now: number = Date.now()): Promise<string | null> {
  return (await takePendingTap(now))?.url ?? null;
}

function openNavChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(NAV_CHANNEL) : null;
  } catch {
    return null;
  }
}

/**
 * One line in the server log per tap step. Never throws, never retries. Every
 * line says whether a worker controls this page: an uncontrolled page gets no
 * client.postMessage, only the BroadcastChannel and the saved copy.
 */
function reportTap(record: Record<string, unknown>): void {
  try {
    void fetch(DIAG_URL, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...record,
        page: runningClientEntry(document),
        controlled: navigator.serviceWorker?.controller != null,
        visibility: document.visibilityState,
      }),
    }).catch(() => undefined);
  } catch {
    // Diagnostics are best-effort.
  }
}

/** Worker messages worth a diag line: the tap itself and the push-shown nudge. */
export function workerMessageDiag(
  data: unknown,
  via: "message" | "broadcast",
): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; id?: unknown };
  if (message.type !== "bots:navigate" && message.type !== "bots:push-shown") return null;
  return {
    event: via === "message" ? "sw-message-received" : "broadcast-received",
    type: message.type,
    id: typeof message.id === "string" ? message.id : null,
  };
}

/**
 * Registers `/sw.js` and routes notification taps from the worker into the
 * router (see notificationTap.ts for why there are so many routes).
 */
export function registerPersonalServiceWorker(navigate: (path: string) => void): void {
  if (
    !shouldRegisterServiceWorker({
      production: import.meta.env.PROD,
      secureContext: window.isSecureContext,
      electron: isElectron,
      supported: "serviceWorker" in navigator,
    })
  ) {
    return;
  }
  const container = navigator.serviceWorker;
  const channel = openNavChannel();
  // Coming back to the app closes no notifications: the untapped ones stay in
  // Notification Center until tapped or read (see staleNotifications.ts).
  const taps = createNotificationTapController({
    navigate,
    currentPath: () => `${window.location.pathname}${window.location.search}`,
    takePending: () => takePendingTap(),
    isVisible: () => document.visibilityState === "visible",
    visibility: () => document.visibilityState,
    now: () => Date.now(),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    ack: (ack) => {
      // Both routes: the worker listens on the channel and for messages.
      try {
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
        channel?.postMessage(ack);
      } catch {
        // The message route below still runs.
      }
      void container
        .getRegistration("/")
        .then((registration) => {
          const worker = container.controller ?? registration?.active ?? null;
          // eslint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker.postMessage has no targetOrigin.
          worker?.postMessage(ack);
        })
        .catch(() => undefined);
    },
    report: reportTap,
  });
  const onWorkerMessage = (data: unknown, via: "message" | "broadcast") => {
    const diag = workerMessageDiag(data, via);
    if (diag !== null) reportTap(diag);
    taps.onMessage(data, via);
  };
  container.addEventListener("message", (event: MessageEvent) =>
    onWorkerMessage(event.data, "message"),
  );
  // Messages from the worker queue until the page opts in; do so explicitly
  // rather than rely on the browser doing it at DOMContentLoaded.
  try {
    container.startMessages();
  } catch {
    // Older engines deliver without it.
  }
  channel?.addEventListener("message", (event: MessageEvent) =>
    onWorkerMessage(event.data, "broadcast"),
  );
  // The installed app only: one line per launch saying whether a worker
  // controls the page, which decides which tap routes can reach it.
  if (isStandaloneDisplay()) reportTap({ event: "page-boot", standalone: true });

  let lastUpdateCheck = 0;
  const checkForNewWorker = () => {
    const now = Date.now();
    if (now - lastUpdateCheck < WORKER_UPDATE_MIN_INTERVAL_MS) return;
    lastUpdateCheck = now;
    // iOS resumes an installed app without a navigation, so the browser's own
    // update check never runs; ask for one so a release reaches the phone.
    void container
      .getRegistration("/")
      .then((registration) => registration?.update())
      .catch(() => undefined);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void taps.check("cache-visible");
    checkForNewWorker();
  });
  window.addEventListener("pageshow", () => {
    if (document.visibilityState === "visible") void taps.check("cache-pageshow");
  });
  window.addEventListener("focus", () => {
    void taps.check("cache-focus");
  });
  void taps.check("cache-load");

  const register = () => {
    void container
      .register(`/sw.js?v=${encodeURIComponent(APP_VERSION)}`, { scope: "/" })
      .then(() => {
        lastUpdateCheck = Date.now();
      })
      .catch(() => {
        // A failed registration only costs offline shell + push; the app works.
      });
  };
  // The entry chunk imports main lazily, so `load` has usually fired already.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/** True when running as an installed PWA (Home Screen / standalone window). */
export function isStandaloneDisplay(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * The active worker registration, if this build registered one. A first launch
 * may still be installing it, so wait a few seconds before giving up.
 */
export async function readyServiceWorker(
  timeoutMs = 5000,
): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (registration?.active) return registration;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/** VAPID base64url public key -> the bytes pushManager.subscribe expects. */
export function applicationServerKeyFrom(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
