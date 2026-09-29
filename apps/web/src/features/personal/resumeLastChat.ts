import type { RouterHistory } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  isPersonalChatPath,
  TEAM_BEHIND_STATE_KEY,
  TEAM_RESUME_STATE_KEY,
  TEAM_VIEW_STATE_KEY,
} from "./botsBackStack";
import { parseTeamView, type TeamView } from "./teamView";
import { usePersonalBackTarget } from "./usePersonalBackTarget";

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

/**
 * The chat was opened from the Team screen, so Back from it goes there. Kept
 * with the chat because the history that says so is gone after iOS ends the app.
 */
export interface SavedTeamOrigin {
  readonly view: TeamView | null;
}

interface SavedChat {
  readonly path: string;
  readonly at: number;
  readonly team: SavedTeamOrigin | null;
}

function parseSaved(raw: string | null): SavedChat | null {
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as {
      path?: unknown;
      at?: unknown;
      team?: unknown;
      teamView?: unknown;
    } | null;
    if (typeof data?.path !== "string" || typeof data.at !== "number") return null;
    return {
      path: data.path,
      at: data.at,
      team: data.team === true ? { view: parseTeamView(data.teamView) } : null,
    };
  } catch {
    return null;
  }
}

/** The saved chat path when it is still fresh, else null (and drops a stale one). */
export function readLastChat(storage: KeyValueStorage | null, now: number): string | null {
  return readLastChatEntry(storage, now)?.path ?? null;
}

/** The saved chat, with where it was opened from, when it is still fresh. */
export function readLastChatEntry(
  storage: KeyValueStorage | null,
  now: number,
): { readonly path: string; readonly team: SavedTeamOrigin | null } | null {
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
    return { path: saved.path, team: saved.team };
  } catch {
    return null;
  }
}

/** A chat on screen is saved (with the time); any other page forgets it. */
export function rememberLastChat(
  storage: KeyValueStorage | null,
  pathname: string,
  now: number,
  team: SavedTeamOrigin | null = null,
): void {
  if (storage === null) return;
  try {
    if (isPersonalChatPath(pathname)) {
      storage.setItem(
        LAST_CHAT_STORAGE_KEY,
        JSON.stringify(
          team === null
            ? { path: pathname, at: now }
            : { path: pathname, at: now, team: true, teamView: team.view },
        ),
      );
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
  const saved = readLastChatEntry(deps.storage, deps.now);
  if (saved === null) return null;
  const { path, team } = saved;
  // A chat opened from the Team screen goes back there: say so, and hand over
  // how the Team screen looked, for botsBackStack to write behind the chat.
  const state =
    team === null
      ? { [RESUMED_STATE_KEY]: true }
      : {
          [RESUMED_STATE_KEY]: true,
          [TEAM_RESUME_STATE_KEY]: true,
          ...(team.view === null ? {} : { [TEAM_VIEW_STATE_KEY]: team.view }),
        };
  history.replace(path, state as never, { ignoreBlocker: true });
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
    const state = (history.location.state ?? {}) as unknown as Record<string, unknown>;
    rememberLastChat(
      deps.storage,
      pathname,
      deps.now(),
      state[TEAM_BEHIND_STATE_KEY] === true
        ? { view: parseTeamView(state[TEAM_VIEW_STATE_KEY]) }
        : null,
    );
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
  // /bots (or the Team screen) sits right behind, so this steps back onto it (botsBackStack.ts).
  goToBots();
  return true;
}

export function useLeaveResumedChatIfGone(pathname: string, gone: boolean): void {
  const navigate = useNavigate();
  const backTarget = usePersonalBackTarget();
  useEffect(() => {
    leaveResumedChatIfGone(pathname, gone, () => void navigate({ to: backTarget.to }));
  }, [backTarget.to, gone, pathname, navigate]);
}

/** Browser defaults for main.tsx. */
export function browserLocalStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
