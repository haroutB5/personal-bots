/*
 * Bots service worker. Registered only by production builds on secure
 * origins (see src/features/personal/serviceWorker.ts).
 *
 * Caching is an allowlist: hashed build assets (/assets/*) cache-first, and
 * the last good app-shell HTML for instant personal-app navigations. Nothing
 * else is ever cached: no API, WebSocket, auth, MCP, attachments, downloads or
 * pairing responses. Every other request is left to the network untouched.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE_PREFIX = "bots-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const SHELL_KEY = "/__bots-shell__";
// Deep link from the last notification tap; see the notificationclick handler.
const PENDING_NAV_CACHE = "bots-pending-nav";
const PENDING_NAV_KEY = "/__bots-pending-nav__";

const NEVER_CACHE = [
  /^\/api(\/|$)/,
  /^\/ws(\/|$)/,
  /^\/oauth(\/|$)/,
  /^\/\.well-known(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/attachments?(\/|$)/,
  /^\/downloads?(\/|$)/,
  /^\/pair(\/|$)/,
  // Always live so the Chats screen shows the running release, not a cached one.
  /^\/version\.txt$/,
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

// Storage can be unavailable or full on a phone. It must never turn a
// successful network response into a failed navigation or script load.
async function cachedResponse(key) {
  try {
    return await caches.match(key, { cacheName: CACHE_NAME });
  } catch {
    return undefined;
  }
}

async function cacheResponse(key, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, response);
  } catch {
    // The response can still be used without an offline copy.
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((pattern) => pattern.test(url.pathname))) return;

  if (request.mode === "navigate") {
    // Reopen the installed app without waiting for a tunnel round trip for
    // static HTML. Refresh the shell in the background for the next launch.
    // Auth and live data still go directly to the server.
    const personalPath = /^\/(?:bots|tasks)(?:\/|$)|^\/(?:files|computer)\/?$/.test(url.pathname);
    event.respondWith(
      (async () => {
        const reload =
          request.isReloadNavigation || request.cache === "reload" || request.cache === "no-cache";
        const cached = personalPath && !reload ? await cachedResponse(SHELL_KEY) : undefined;
        const network = (async () => {
          try {
            const response = await fetch(request);
            const type = response.headers.get("Content-Type") || "";
            if (
              response.ok &&
              response.type === "basic" &&
              !response.redirected &&
              type.includes("text/html")
            ) {
              event.waitUntil(cacheResponse(SHELL_KEY, response.clone()));
            }
            return response;
          } catch (error) {
            const cached = await cachedResponse(SHELL_KEY);
            if (cached) return cached;
            throw error;
          }
        })();
        if (cached) {
          event.waitUntil(network.catch(() => undefined));
          return cached;
        }
        return network;
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // Content-hashed file names: a cached copy is always the right bytes.
    event.respondWith(
      (async () => {
        const cached = await cachedResponse(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (isCacheableResponse(response)) {
          event.waitUntil(cacheResponse(request, response.clone()));
        }
        return response;
      })(),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = (event.data ? event.data.json() : null) ?? {};
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
      const url = new URL(href).pathname + new URL(href).search;
      // iOS can drop a message to an app it is still waking, so the page also
      // reads this when it becomes visible. Its cache name sits outside
      // CACHE_PREFIX, so activate never deletes it.
      try {
        const cache = await caches.open(PENDING_NAV_CACHE);
        await cache.put(PENDING_NAV_KEY, new Response(JSON.stringify({ url, at: Date.now() })));
      } catch {
        // The message below still carries the link.
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // Client.postMessage has no targetOrigin; the client is same-origin (checked above).
        /* eslint-disable unicorn/require-post-message-target-origin */
        client.postMessage({ type: "bots:navigate", url });
        /* eslint-enable unicorn/require-post-message-target-origin */
        // iOS brings the installed app forward itself and can refuse focus();
        // that must not cost the deep link, so it runs last and never throws.
        try {
          await client.focus();
        } catch {
          // Already in front.
        }
        return;
      }
      await self.clients.openWindow(href);
    })(),
  );
});
