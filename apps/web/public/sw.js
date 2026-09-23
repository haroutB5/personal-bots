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
// Second delivery route for notification taps that does not depend on
// clients.matchAll(). Must match NAV_CHANNEL in src/features/personal/serviceWorker.ts.
const NAV_CHANNEL = "bots-nav";
// One low-volume line per tap in the server log (see personal/clientDiagRoute.ts).
const DIAG_URL = "/api/personal/client-diag";

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

/*
 * Notification icon.
 *
 * A push payload names the sending bot's avatar with two fields, `avatarShape`
 * and `avatarColor` (see PersonalPushPayload). The avatar is drawn here, into
 * an OffscreenCanvas, and handed to the notification as an object URL: the
 * artwork never needs a public URL or an auth surface, and cannot expire
 * between the send and the display.
 *
 * The geometry is fetched, not copied: `/bot-avatar-shapes.json` is generated
 * from the same module the app draws avatars with, so the silhouettes here and
 * in the chats list are the same paths.
 *
 * iOS ignores `icon` entirely and always shows the PWA manifest icon, so none
 * of this changes anything on an iPhone - it is for Android and desktop.
 *
 * Every step is best-effort: an old payload without the fields, an unsupported
 * API, a failed fetch, a slow draw or an icon the platform refuses all end in
 * the app icon and a notification that still appears.
 */
const NOTIFICATION_FALLBACK_ICON = "/apple-touch-icon.png";
const AVATAR_GEOMETRY_URL = "/bot-avatar-shapes.json";
/** Notification large-icon size; Android asks for up to 192 CSS px. */
const AVATAR_ICON_PX = 192;
/** A banner is worth more than its icon: give up drawing after this. */
const AVATAR_RENDER_TIMEOUT_MS = 3000;
const AVATAR_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

let avatarGeometryPromise = null;

function avatarGeometry() {
  if (avatarGeometryPromise === null) {
    avatarGeometryPromise = (async () => {
      const response = await fetch(AVATAR_GEOMETRY_URL);
      if (!response.ok) throw new Error(`Avatar geometry answered ${response.status}.`);
      return await response.json();
    })().catch((error) => {
      // A failed fetch must not poison every later notification.
      avatarGeometryPromise = null;
      throw error;
    });
  }
  return avatarGeometryPromise;
}

/** Draws the bot's avatar and returns an object URL, or null if it cannot. */
async function botAvatarIconUrl(shape, color) {
  if (typeof shape !== "string" || typeof color !== "string") return null;
  if (!AVATAR_COLOR_PATTERN.test(color)) return null;
  if (typeof OffscreenCanvas !== "function" || typeof Path2D !== "function") return null;
  const geometry = await avatarGeometry();
  const silhouette = geometry.silhouettes[shape];
  const eyes = geometry.eyes[shape];
  if (!silhouette || !eyes) return null;
  const canvas = new OffscreenCanvas(AVATAR_ICON_PX, AVATAR_ICON_PX);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const scale = AVATAR_ICON_PX / geometry.viewBoxSize;
  context.scale(scale, scale);
  const path = new Path2D(silhouette.d);
  context.fillStyle = color;
  // eslint-disable-next-line unicorn/no-array-fill-with-reference-type -- CanvasRenderingContext2D.fill(path), not Array#fill.
  context.fill(path);
  if (silhouette.roundCorners) {
    // Same trick as the SVG: stroking the path in its own colour with round
    // joins is what softens the triangle's and the hexagon's vertices.
    context.strokeStyle = color;
    context.lineWidth = geometry.roundCornerStroke;
    context.lineJoin = "round";
    context.stroke(path);
  }
  context.fillStyle = geometry.eye.color;
  for (const eye of eyes) {
    context.save();
    context.translate(eye.cx, eye.cy);
    context.rotate((geometry.eye.tiltDeg * Math.PI) / 180);
    context.beginPath();
    context.roundRect(
      -geometry.eye.width / 2,
      -geometry.eye.height / 2,
      geometry.eye.width,
      geometry.eye.height,
      geometry.eye.width / 2,
    );
    context.fill();
    context.restore();
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return URL.createObjectURL(blob);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Avatar render timed out.")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = (event.data ? event.data.json() : null) ?? {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title.length > 0 ? data.title : "Bots";
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/bots";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    data: { url },
    icon: NOTIFICATION_FALLBACK_ICON,
  };
  event.waitUntil(
    (async () => {
      let iconUrl = null;
      // A payload from before this field existed, or one with no bot behind
      // it, goes straight to the app icon and never starts a render.
      if (typeof data.avatarShape === "string" && typeof data.avatarColor === "string") {
        try {
          iconUrl = await withTimeout(
            botAvatarIconUrl(data.avatarShape, data.avatarColor).catch(() => null),
            AVATAR_RENDER_TIMEOUT_MS,
          );
        } catch {
          iconUrl = null;
        }
      }
      try {
        await self.registration.showNotification(
          title,
          iconUrl === null ? options : { ...options, icon: iconUrl },
        );
      } catch (error) {
        // The drawn icon is the only thing that changed here, so a notification
        // the platform refused is retried with the app icon rather than lost.
        if (iconUrl === null) throw error;
        await self.registration.showNotification(title, options);
      } finally {
        if (iconUrl !== null) URL.revokeObjectURL(iconUrl);
      }
      // An open app watches for the tap for a while after this (see
      // serviceWorker.ts): iOS gives a foreground app no event when the
      // banner is tapped, so the page polls the saved deep link instead.
      const { broadcast, windows } = await announce({ type: "bots:push-shown", at: Date.now() });
      // One line per push: proves this worker can reach the server at all, and
      // shows which windows it can see (and whether the app was in front).
      await sendDiag({
        event: "push-shown",
        sw: VERSION,
        url: pathOf(new URL(url, self.location.origin).href),
        broadcast,
        clients: describeWindows(windows),
      });
    })(),
  );
});

/*
 * Notification taps.
 *
 * The deep link travels by every route at once, because on iOS each one alone
 * has been seen to fail: the saved copy in PENDING_NAV_CACHE (read by the page
 * when it becomes visible, gains focus, or polls after a push), a
 * BroadcastChannel, and a postMessage to every open window. The page answers
 * with "bots:navigate-ack"; if nobody does, the worker navigates the window
 * itself. Each tap carries an id so the page acts on it once.
 */

let navChannelInstance = null;

function navChannel() {
  if (navChannelInstance !== null) return navChannelInstance;
  try {
    if (typeof BroadcastChannel !== "function") return null;
    navChannelInstance = new BroadcastChannel(NAV_CHANNEL);
    navChannelInstance.addEventListener("message", (event) => settleAck(event.data));
  } catch {
    navChannelInstance = null;
  }
  return navChannelInstance;
}

/** Tap id -> resolver waiting for the page's acknowledgement. */
const ackWaiters = new Map();

function settleAck(data) {
  if (!data || data.type !== "bots:navigate-ack" || typeof data.id !== "string") return;
  const resolve = ackWaiters.get(data.id);
  if (resolve === undefined) return;
  ackWaiters.delete(data.id);
  resolve({
    via: typeof data.via === "string" ? data.via.slice(0, 32) : "unknown",
    visibility: typeof data.visibility === "string" ? data.visibility.slice(0, 16) : null,
  });
}

self.addEventListener("message", (event) => settleAck(event.data));

function waitForAck(id, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(id);
      resolve(null);
    }, ms);
    ackWaiters.set(id, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function sameOriginWindows(windows) {
  return windows.filter((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
}

/** Tells every open window, by both routes. Returns how far it got. */
async function announce(message) {
  let broadcast = false;
  const channel = navChannel();
  if (channel !== null) {
    try {
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
      channel.postMessage(message);
      broadcast = true;
    } catch {
      // The postMessage route below still runs.
    }
  }
  let windows = [];
  try {
    windows = sameOriginWindows(
      await self.clients.matchAll({ type: "window", includeUncontrolled: true }),
    );
  } catch {
    windows = [];
  }
  for (const client of windows) {
    try {
      // Client.postMessage has no targetOrigin; the client is same-origin (checked above).
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      client.postMessage(message);
    } catch {
      // One refused window must not stop the others.
    }
  }
  return { broadcast, windows };
}

function pathOf(href) {
  try {
    const url = new URL(href);
    return (url.pathname + url.search).slice(0, 200);
  } catch {
    return null;
  }
}

function newTapId() {
  try {
    if (self.crypto && typeof self.crypto.randomUUID === "function")
      return self.crypto.randomUUID();
  } catch {
    // Fall through to the time-based id.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Fire-and-forget: one line in the server log, never a failed tap. No
 * `keepalive`: the caller's waitUntil already keeps the worker alive, and
 * WebKit has refused keepalive requests from workers. The route accepts
 * anonymous posts (allowlisted), because this fetch may carry no credential.
 */
async function sendDiag(record) {
  try {
    await fetch(DIAG_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  } catch {
    // Diagnostics are best-effort.
  }
}

function describeWindows(windows) {
  return windows.slice(0, 5).map((client) => ({
    path: pathOf(client.url),
    visibility: typeof client.visibilityState === "string" ? client.visibilityState : null,
    focused: typeof client.focused === "boolean" ? client.focused : null,
  }));
}

/** A foreground app answers in well under a second; a waking one takes longer. */
const NAV_ACK_TIMEOUT_VISIBLE_MS = 2500;
const NAV_ACK_TIMEOUT_WAKING_MS = 6000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

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
  const started = Date.now();
  const url = new URL(href).pathname + new URL(href).search;
  const id = newTapId();
  // First thing, before any await: if this line is missing for a tap, the
  // platform never ran the handler (or killed the worker before it could post).
  const startDiag = sendDiag({
    event: "notificationclick-start",
    sw: VERSION,
    id,
    url,
    at: started,
  });
  event.waitUntil(startDiag);
  event.waitUntil(
    (async () => {
      const diag = { event: "notificationclick", sw: VERSION, id, url, cache: false };
      // Listen before anything is sent, so a fast page cannot answer too early.
      const ack = waitForAck(id, NAV_ACK_TIMEOUT_WAKING_MS);
      // The saved copy covers a page that misses both messages. Its cache name
      // sits outside CACHE_PREFIX, so activate never deletes it.
      try {
        const cache = await caches.open(PENDING_NAV_CACHE);
        await cache.put(PENDING_NAV_KEY, new Response(JSON.stringify({ url, id, at: Date.now() })));
        diag.cache = true;
      } catch {
        // The messages still carry the link.
      }
      const { broadcast, windows } = await announce({ type: "bots:navigate", url, id });
      diag.broadcast = broadcast;
      diag.clients = describeWindows(windows);
      const front =
        windows.find((client) => client.focused === true) ??
        windows.find((client) => client.visibilityState === "visible") ??
        windows[0];
      if (front === undefined) {
        try {
          await self.clients.openWindow(href);
          diag.route = "openWindow";
        } catch (error) {
          diag.route = "openWindow-refused";
          diag.error = String((error && error.name) || error).slice(0, 80);
        }
      } else {
        // iOS brings the installed app forward itself and can refuse focus();
        // that must never cost the deep link.
        try {
          await front.focus();
          diag.focus = "ok";
        } catch {
          diag.focus = "refused";
        }
      }
      const answer = await Promise.race([
        ack,
        delay(
          front !== undefined && front.visibilityState === "visible"
            ? NAV_ACK_TIMEOUT_VISIBLE_MS
            : NAV_ACK_TIMEOUT_WAKING_MS,
        ),
      ]);
      ackWaiters.delete(id);
      diag.ack = answer;
      if (answer === null && front !== undefined) {
        // No page acted on the link: take the window there directly. A full
        // load of the deep link is slower than a route change, but it lands.
        try {
          if (typeof front.navigate !== "function") throw new Error("navigate unsupported");
          await front.navigate(href);
          diag.route = "client.navigate";
        } catch (error) {
          diag.error = String((error && error.name) || error).slice(0, 80);
          try {
            await self.clients.openWindow(href);
            diag.route = "openWindow-late";
          } catch {
            diag.route = "none";
          }
        }
      } else if (front !== undefined) {
        diag.route = "page";
      }
      diag.ms = Date.now() - started;
      await sendDiag(diag);
    })(),
  );
});
