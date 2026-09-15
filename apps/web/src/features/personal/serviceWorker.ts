import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";

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

/** Must match PENDING_NAV_CACHE / PENDING_NAV_KEY in public/sw.js. */
const PENDING_NAV_CACHE = "bots-pending-nav";
const PENDING_NAV_KEY = "/__bots-pending-nav__";
/** An older tap is not what the user is opening the app for now. */
const PENDING_NAV_MAX_AGE_MS = 2 * 60_000;

/**
 * Takes (and clears) the deep link the worker saved for the last notification
 * tap, or null when there is none, it is stale or it is not a safe path.
 */
export async function takePendingNavigation(now: number = Date.now()): Promise<string | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(PENDING_NAV_CACHE);
    const response = await cache.match(PENDING_NAV_KEY);
    if (response === undefined) return null;
    await cache.delete(PENDING_NAV_KEY);
    const data = (await response.json()) as { url?: unknown; at?: unknown } | null;
    const fresh = typeof data?.at === "number" && now - data.at < PENDING_NAV_MAX_AGE_MS;
    return fresh && isNavigablePath(data?.url) ? data.url : null;
  } catch {
    return null;
  }
}

/**
 * Registers `/sw.js` (versioned by build, so each release gets a fresh shell
 * cache) and routes notification clicks from the worker into the router: by
 * message, and by the saved deep link when the app becomes visible (iOS can
 * drop the message to an app it is still waking).
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
  const go = (path: string) => {
    if (`${window.location.pathname}${window.location.search}` !== path) navigate(path);
  };
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== "bots:navigate" || !isNavigablePath(data.url)) return;
    // The message won; clear the saved copy so a later resume does not repeat it.
    void takePendingNavigation();
    go(data.url);
  });
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    void takePendingNavigation().then((path) => {
      if (path !== null) go(path);
    });
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onVisible);
  onVisible();
  const register = () => {
    void navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(APP_VERSION)}`, { scope: "/" })
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
