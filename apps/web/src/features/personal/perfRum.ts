/**
 * Real-user timings from the phone, one small beacon per journey, into the
 * server log (`client-diag {"event":"perf",...}`). The lab bench
 * (scripts/personal/perf) measures the same journeys on a desktop CPU; these
 * say what the iPhone actually sees. Summarise with
 * `node scripts/personal/perf/rum.mjs`.
 *
 *   j1       app opened on the chats list  -> first chat rows painted
 *   j1-chat  app opened straight into a chat -> transcript + composer painted
 *   j2       tap on a chat row               -> transcript + composer painted
 *   j3-echo  message sent                    -> the server's copy is in the chat
 *   j3-first message sent                    -> the reply's first text is painted
 *
 * Timings are skipped when the page was hidden at any point during the
 * journey (background time is not app time). Kill switch: "rum".
 */
import { perfOptimizationOn } from "./perfFlags";

const DIAG_URL = "/api/personal/client-diag";
/** A tap older than this did not start the chat that is opening now. */
const TAP_WINDOW_MS = 15_000;
/** A reply slower than this is the model thinking, not the app. */
const SEND_WINDOW_MS = 120_000;

export type PerfJourney = "j1" | "j1-chat" | "j2" | "j3-echo" | "j3-first";

interface Clock {
  readonly now: () => number;
}

let hiddenAt: number | null = null;
const reportedLoads = new Set<PerfJourney>();
let tap: { readonly path: string; readonly at: number } | null = null;
let send: {
  readonly threadId: string;
  readonly at: number;
  readonly known: ReadonlySet<string>;
  echoed: boolean;
} | null = null;

const clock: Clock = { now: () => performance.now() };

function hiddenSince(at: number): boolean {
  return hiddenAt !== null && hiddenAt >= at;
}

/** Path the page was first loaded at (the navigation, not the current route). */
function loadPath(): string | null {
  try {
    const entry = performance.getEntriesByType("navigation")[0];
    return entry ? new URL(entry.name).pathname : null;
  } catch {
    return null;
  }
}

function beacon(record: Record<string, unknown>): void {
  if (!perfOptimizationOn("rum")) return;
  try {
    const body = JSON.stringify({
      event: "perf",
      warm: navigator.serviceWorker?.controller != null,
      via: location.hostname.endsWith(".t3coderelay.com") ? "relay" : "direct",
      ...record,
    });
    void fetch(DIAG_URL, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => undefined);
  } catch {
    // Timings are best-effort.
  }
}

/** Calls `done` with the time of the frame that paints what was just rendered. */
function atPaint(done: (at: number) => void): void {
  if (typeof requestAnimationFrame !== "function") {
    done(clock.now());
    return;
  }
  requestAnimationFrame((at) => done(at));
}

let installed = false;

/** Starts watching visibility and chat-row taps. Safe to call more than once. */
export function installPerfRum(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  if (document.visibilityState !== "visible") hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") hiddenAt = clock.now();
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Element | null;
      const link = target?.closest?.('a[href^="/bots/"]');
      const href = link?.getAttribute("href");
      if (href) tap = { path: href, at: clock.now() };
    },
    { capture: true, passive: true },
  );
}

/** The chats list painted its first rows (from the snapshot or live). */
export function reportChatsListPainted(fromSnapshot: boolean): void {
  if (reportedLoads.has("j1") || !isChatsListLoad(loadPath())) return;
  reportedLoads.add("j1");
  atPaint((at) => {
    if (hiddenSince(0)) return;
    beacon({ journey: "j1", ms: Math.round(at), snapshot: fromSnapshot });
  });
}

/** A chat's transcript and composer are on screen. */
export function reportChatUsable(path: string): void {
  const startedByTap = tap !== null && tap.path === path && clock.now() - tap.at < TAP_WINDOW_MS;
  if (startedByTap) {
    const started = tap!.at;
    tap = null;
    atPaint((at) => {
      if (hiddenSince(started)) return;
      beacon({ journey: "j2", ms: Math.round(at - started) });
    });
    return;
  }
  if (reportedLoads.has("j1-chat") || loadPath() !== path) return;
  reportedLoads.add("j1-chat");
  atPaint((at) => {
    if (hiddenSince(0)) return;
    beacon({ journey: "j1-chat", ms: Math.round(at) });
  });
}

interface ObservedMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

/** The user sent a message in `threadId`; `messages` is what the chat held before it. */
export function markMessageSent(threadId: string, messages: ReadonlyArray<ObservedMessage>): void {
  send = {
    threadId,
    at: clock.now(),
    known: new Set(messages.map((message) => message.id)),
    echoed: false,
  };
}

/** Called with the chat's messages whenever they change. */
export function observeChatMessages(
  threadId: string,
  messages: ReadonlyArray<ObservedMessage>,
): void {
  const pending = send;
  if (pending === null || pending.threadId !== threadId) return;
  if (clock.now() - pending.at > SEND_WINDOW_MS) {
    send = null;
    return;
  }
  const fresh = messages.filter((message) => !pending.known.has(message.id));
  if (!pending.echoed && fresh.some((message) => message.role === "user")) {
    pending.echoed = true;
    atPaint((at) => {
      if (!hiddenSince(pending.at)) beacon({ journey: "j3-echo", ms: Math.round(at - pending.at) });
    });
  }
  if (fresh.some((message) => message.role === "assistant" && message.text.length > 0)) {
    send = null;
    atPaint((at) => {
      if (!hiddenSince(pending.at))
        beacon({ journey: "j3-first", ms: Math.round(at - pending.at) });
    });
  }
}

/** True when the page was loaded on the chats list itself. */
export function isChatsListLoad(path: string | null): boolean {
  return path !== null && /^\/bots\/?$/.test(path);
}

/** Test hook: forget everything between tests. */
export function resetPerfRumForTest(now?: () => number): void {
  hiddenAt = null;
  reportedLoads.clear();
  tap = null;
  send = null;
  installed = false;
  (clock as { now: () => number }).now = now ?? (() => performance.now());
}
