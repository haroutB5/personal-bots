/*
 * Bots service worker. Registered only by production builds on secure
 * origins (see src/features/personal/serviceWorker.ts).
 *
 * Caching is an allowlist: hashed build assets (/assets/*) cache-first, and
 * the last good app-shell HTML as an offline fallback for navigations. Nothing
 * else is ever cached: no API, WebSocket, auth, MCP, attachments, downloads or
 * pairing responses. Every other request is left to the network untouched.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE_PREFIX = "bots-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const SHELL_KEY = "/__bots-shell__";

const NEVER_CACHE = [
  /^\/api(\/|$)/,
  /^\/ws(\/|$)/,
  /^\/oauth(\/|$)/,
  /^\/\.well-known(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/attachments?(\/|$)/,
  /^\/downloads?(\/|$)/,
  /^\/pair(\/|$)/,
];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function isCacheableResponse(response) {
  if (!response || !response.ok || response.type !== "basic" || response.redirected) return false;
  const disposition = response.headers.get("Content-Disposition") || "";
  const cacheControl = response.headers.get("Cache-Control") || "";
  return !/attachment/i.test(disposition) && !/no-store|private/i.test(cacheControl);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((pattern) => pattern.test(url.pathname))) return;

  if (request.mode === "navigate") {
    // Network first; the cached shell only answers when the network fails.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const type = response.headers.get("Content-Type") || "";
          if (
            response.ok &&
            response.type === "basic" &&
            !response.redirected &&
            type.includes("text/html")
          ) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(SHELL_KEY, response.clone());
          }
          return response;
        } catch (error) {
          const cached = await caches.match(SHELL_KEY, { cacheName: CACHE_NAME });
          if (cached) return cached;
          throw error;
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // Content-hashed file names: a cached copy is always the right bytes.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (isCacheableResponse(response)) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title.length > 0 ? data.title : "Bots";
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/bots";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url },
      icon: "/apple-touch-icon.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path =
    event.notification.data && typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/bots";
  // Same-origin deep links only.
  const target = new URL(path, self.location.origin);
  const href =
    target.origin === self.location.origin
      ? target.href
      : new URL("/bots", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // Client.postMessage has no targetOrigin; the client is same-origin (checked above).
        // eslint-disable-next-line unicorn/require-post-message-target-origin
        client.postMessage({
          type: "bots:navigate",
          url: new URL(href).pathname + new URL(href).search,
        });
        return;
      }
      await self.clients.openWindow(href);
    })(),
  );
});
