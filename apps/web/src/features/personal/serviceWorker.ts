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
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

/**
 * Registers `/sw.js` (versioned by build, so each release gets a fresh shell
 * cache) and routes notification clicks from the worker into the router.
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
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === "bots:navigate" && isNavigablePath(data.url)) navigate(data.url);
  });
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
