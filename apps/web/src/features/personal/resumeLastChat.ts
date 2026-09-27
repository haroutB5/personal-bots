import type { RouterHistory } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { isPersonalChatPath } from "./botsBackStack";

/**
 * Reopens the chat the user left when the installed app comes back cold.
 *
 * iOS evicts the PWA in the background every 10-40 minutes, and a relaunch
 * opens the manifest's start_url (/bots) instead of the page that was on
 * screen. So the open bot or group chat is remembered while it is shown and
 * when the app is hidden, forgotten as soon as the user goes to any other
 * page themselves, and put back on a plain relaunch at /bots. It is swapped
 * in before the router exists, so the Bots list never paints on the way, and
 * botsBackStack.ts then puts /bots behind it as for any cold deep link.
 */
export const LAST_CHAT_STORAGE_KEY = "bots:last-chat";
/** A chat left longer ago than this is not "the chat I was just in". */
export const LAST_CHAT_MAX_AGE_MS = 12 * 60 * 60_000;
/**
 * Where a relaunch lands: the manifest's start_url, or "/" (which redirects
 * to /bots) for a Home Screen icon saved from a page before the manifest.
 */
const START_PATHS: ReadonlySet<string> = new Set(["/bots", "/"]);
/**
 * Marks the history entry a relaunch reopened, so a reload of it (the
 * stale-release reload right after boot) still knows it was not chosen.
 */
const RESUMED_STATE_KEY = "personalResumedChat";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface SavedChat {
  readonly path: string;
  readonly at: number;
}

function parseSaved(raw: string | null): SavedChat | null {
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as { path?: unknown; at?: unknown } | null;
    if (typeof data?.path !== "string" || typeof data.at !== "number") return null;
    return { path: data.path, at: data.at };
  } catch {
    return null;
  }
}

/** The saved chat path when it is still fresh, else null (and drops a stale one). */
export function readLastChat(storage: KeyValueStorage | null, now: number): string | null {
  if (storage === null) return null;
  try {
    const saved = parseSaved(storage.getItem(LAST_CHAT_STORAGE_KEY));
    const fresh =
      saved !== null &&
      isPersonalChatPath(saved.path) &&
      now - saved.at >= 0 &&
      now - saved.at < LAST_CHAT_MAX_AGE_MS;
    if (!fresh) {
      storage.removeItem(LAST_CHAT_STORAGE_KEY);
      return null;
    }
    return saved.path;
  } catch {
    return null;
  }
}

/** A chat on screen is saved (with the time); any other page forgets it. */
export function rememberLastChat(
  storage: KeyValueStorage | null,
  pathname: string,
  now: number,
): void {
  if (storage === null) return;
  try {
    if (isPersonalChatPath(pathname)) {
      storage.setItem(LAST_CHAT_STORAGE_KEY, JSON.stringify({ path: pathname, at: now }));
    } else {
      storage.removeItem(LAST_CHAT_STORAGE_KEY);
    }
  } catch {
    // Storage full or blocked: the relaunch opens /bots as before.
  }
}

// The chat this launch reopened, until the user moves off it.
let resumedChat: string | null = null;

export function resumedChatPath(): string | null {
  return resumedChat;
}

export interface ResumeBootDeps {
  readonly storage: KeyValueStorage | null;
  readonly now: number;
  /** Only the installed app relaunches at its start_url. */
  readonly standalone: boolean;
}

/**
 * Call before the router is created. On a plain relaunch (exactly /bots or /,
 * no query, no hash) of the installed app with a fresh saved chat, the current
 * entry becomes that chat. Any other address (a notification tap, a deep
 * link, a reload of some page) is left alone. Returns the reopened path.
 */
export function resumeLastChatAtBoot(history: RouterHistory, deps: ResumeBootDeps): string | null {
  resumedChat = null;
  const here = history.location;
  if ((here.state as unknown as Record<string, unknown>)[RESUMED_STATE_KEY] === true) {
    resumedChat = isPersonalChatPath(here.pathname) ? here.pathname : null;
    return null;
  }
  if (!deps.standalone) return null;
  if (!START_PATHS.has(here.pathname) || here.search !== "" || here.hash !== "") return null;
  const path = readLastChat(deps.storage, deps.now);
  if (path === null) return null;
  history.replace(path, { [RESUMED_STATE_KEY]: true } as never, { ignoreBlocker: true });
  history.flush();
  resumedChat = path;
  return path;
}

export interface TrackLastChatDeps {
  readonly storage: KeyValueStorage | null;
  readonly now: () => number;
  readonly document?: Pick<Document, "addEventListener" | "visibilityState">;
  readonly window?: Pick<Window, "addEventListener">;
}

/**
 * Keeps the saved chat in step with what is on screen: every navigation
 * saves or forgets it, and hiding the app stamps the time it was left.
 */
export function trackLastChat(history: RouterHistory, deps: TrackLastChatDeps): () => void {
  const record = () => {
    const { pathname } = history.location;
    if (resumedChat !== null && pathname !== resumedChat) resumedChat = null;
    rememberLastChat(deps.storage, pathname, deps.now());
  };
  record();
  const unsubscribe = history.subscribe(record);
  const onHidden = () => {
    if (deps.document?.visibilityState === "hidden") record();
  };
  deps.document?.addEventListener("visibilitychange", onHidden);
  deps.window?.addEventListener("pagehide", record);
  return unsubscribe;
}

/**
 * A reopened chat that was deleted, archived or lost its bot since goes
 * quietly back to the Bots page behind it. A chat opened any other way keeps
 * showing its own "deleted" message. Returns whether it left.
 */
export function leaveResumedChatIfGone(
  pathname: string,
  gone: boolean,
  goToBots: () => void,
): boolean {
  if (!gone || resumedChat !== pathname) return false;
  resumedChat = null;
  // /bots sits right behind, so this steps back onto it (botsBackStack.ts).
  goToBots();
  return true;
}

export function useLeaveResumedChatIfGone(pathname: string, gone: boolean): void {
  const navigate = useNavigate();
  useEffect(() => {
    leaveResumedChatIfGone(pathname, gone, () => void navigate({ to: "/bots" }));
  }, [gone, pathname, navigate]);
}

/** Browser defaults for main.tsx. */
export function browserLocalStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
