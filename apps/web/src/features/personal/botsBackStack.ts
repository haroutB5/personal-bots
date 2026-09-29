import type { RouterHistory } from "@tanstack/react-router";

import { captureTeamView, parseTeamView, type TeamView } from "./teamView";

type HistoryLocation = RouterHistory["location"];
type NavigationBlocker = Parameters<RouterHistory["block"]>[0];
type NavigateOptions = Parameters<RouterHistory["push"]>[2];

const BOTS_PATH = "/bots";
const TEAM_PATH = "/bots/team";

/**
 * Set on a history entry when the entry directly behind it is /bots. It lives
 * in the browser's history state, so it survives reloads and back/forward.
 */
export const BOTS_BEHIND_STATE_KEY = "personalBotsBehind";
/**
 * Set on a history entry opened from the Team screen (a bot's page, its chats,
 * its edit form, a chat or a task) when the entry directly behind it is
 * /bots/team. Back from these lands on the Team screen, not on /bots.
 */
export const TEAM_BEHIND_STATE_KEY = "personalTeamBehind";
/** The Team screen as it was left (teamView.ts), on the Team entry and on the entries opened from it. */
export const TEAM_VIEW_STATE_KEY = "personalTeamView";
/**
 * Set by the relaunch that reopens a chat which was opened from the Team screen:
 * there is no history behind it any more, so the Team screen is put there.
 */
export const TEAM_RESUME_STATE_KEY = "personalTeamResume";

/** Where Back from an entry lands: the Bots list, the Team screen, or wherever history goes. */
export type BehindKind = "bots" | "team" | null;

const CHAT_PATH = /^\/bots\/([^/]+)\/([^/]+)\/?$/;

/** A bot chat (/bots/$botId/$threadId) or a group chat (/bots/groups/$groupId). */
export function isPersonalChatPath(pathname: string): boolean {
  const match = CHAT_PATH.exec(pathname);
  if (match === null) return false;
  const [, first, second] = match;
  if (first === "groups") return second !== "new";
  if (first === "teams") return second !== "new";
  return first !== "settings" && second !== "edit";
}

function isBotsPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === BOTS_PATH;
}

function isTeamPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === TEAM_PATH;
}

const NOT_A_BOT = new Set(["team", "teams", "new", "settings", "groups"]);
const BOT_PAGE_PATH = /^\/bots\/([^/]+)\/?$/;
const BOT_EDIT_PATH = /^\/bots\/([^/]+)\/edit\/?$/;
const TASK_PAGE_PATH = /^\/tasks\/([^/]+)\/?$/;

/**
 * Pages the Team screen opens: a bot's page (its chats), its edit form, a bot
 * chat, and a task page (a "Working now" row whose task has no chat yet).
 * Group chats are not among them.
 */
export function isTeamOpenedPath(pathname: string): boolean {
  const bot = BOT_PAGE_PATH.exec(pathname) ?? BOT_EDIT_PATH.exec(pathname);
  if (bot !== null) return !NOT_A_BOT.has(bot[1] ?? "");
  if (TASK_PAGE_PATH.test(pathname)) return pathname.replace(/\/+$/, "") !== "/tasks/routines";
  const chat = CHAT_PATH.exec(pathname);
  return chat !== null && chat[1] !== "groups" && isPersonalChatPath(pathname);
}

function stateOf(state: unknown): Record<string, unknown> {
  return (state ?? {}) as Record<string, unknown>;
}

/** What is directly behind an entry, from its history state. */
export function behindOfState(state: unknown): BehindKind {
  const record = stateOf(state);
  if (record[TEAM_BEHIND_STATE_KEY] === true) return "team";
  if (record[BOTS_BEHIND_STATE_KEY] === true) return "bots";
  return null;
}

/** The Bots page, or the Team screen, whichever Back from this entry should reach. */
export function backTargetOfState(state: unknown): "/bots" | "/bots/team" {
  return behindOfState(state) === "team" ? TEAM_PATH : BOTS_PATH;
}

function splitHref(href: string): { pathname: string; rest: string } {
  const end = href.search(/[?#]/);
  return end === -1
    ? { pathname: href, rest: "" }
    : { pathname: href.slice(0, end), rest: href.slice(end) };
}

function behindOf(location: HistoryLocation): BehindKind {
  return behindOfState(location.state);
}

function withBehind(
  state: unknown,
  behind: BehindKind,
  teamView: TeamView | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stateOf(state) };
  delete next[BOTS_BEHIND_STATE_KEY];
  delete next[TEAM_BEHIND_STATE_KEY];
  delete next[TEAM_VIEW_STATE_KEY];
  delete next[TEAM_RESUME_STATE_KEY];
  if (behind === "bots") next[BOTS_BEHIND_STATE_KEY] = true;
  if (behind === "team") {
    next[TEAM_BEHIND_STATE_KEY] = true;
    if (teamView !== null) next[TEAM_VIEW_STATE_KEY] = teamView;
  }
  return next;
}

type Step =
  | { kind: "back" }
  | { kind: "push" | "replace"; behind: BehindKind; insertBots: boolean };

function planStep(type: "push" | "replace", current: HistoryLocation, href: string): Step {
  const dest = splitHref(href);
  const behind = behindOf(current);
  const toTeamOpened = isTeamOpenedPath(dest.pathname);
  // Opened from the Team screen: it stays right behind, however deep the owner
  // goes (bot page, chat, edit form), so every way back ends on it.
  if (type === "push" && toTeamOpened && isTeamPath(current.pathname)) {
    return { kind: "push", behind: "team", insertBots: false };
  }
  if (toTeamOpened && behind === "team" && isTeamOpenedPath(current.pathname)) {
    return { kind: "replace", behind: "team", insertBots: false };
  }
  // Going to the Team screen when it sits right behind (an arrow on a page it
  // opened) steps back, so history does not grow a team -> bot -> team loop.
  if (type === "push" && isTeamPath(dest.pathname) && dest.rest === "" && behind === "team") {
    return { kind: "back" };
  }
  if (isPersonalChatPath(dest.pathname)) {
    // /bots is already behind this entry: the chat takes its place, so a
    // chat opened from a chat, a task page or a bot's list never stacks.
    if (behind === "bots") return { kind: "replace", behind: "bots", insertBots: false };
    if (isBotsPath(current.pathname)) return { kind: "push", behind: "bots", insertBots: false };
    // Anywhere else: this entry becomes /bots and the chat goes on top.
    return { kind: "push", behind: "bots", insertBots: true };
  }
  // Going to /bots when it sits right behind (a chat's Back arrow, the Bots
  // tab) steps back, so history does not grow a /bots -> chat -> /bots loop.
  if (type === "push" && isBotsPath(dest.pathname) && dest.rest === "" && behind === "bots") {
    return { kind: "back" };
  }
  return type === "push"
    ? { kind: "push", behind: isBotsPath(current.pathname) ? "bots" : null, insertBots: false }
    : { kind: "replace", behind, insertBots: false };
}

function locationFor(href: string, state: unknown): HistoryLocation {
  const { pathname, rest } = splitHref(href);
  const hashAt = rest.indexOf("#");
  return {
    href,
    pathname,
    search: hashAt === -1 ? rest : rest.slice(0, hashAt),
    hash: hashAt === -1 ? "" : rest.slice(hashAt),
    state: state as HistoryLocation["state"],
  };
}

/**
 * Makes going back from any bot or group chat land on the Bots page, whatever
 * opened the chat: history back (iOS swipe-back, browser Back) then matches
 * the chat's own Back arrow.
 *
 * It works on the history the router reads, so every way into a chat (links,
 * navigate(), redirects, notification taps, a cold deep link) follows the
 * same rule. The /bots entry under a chat is written without telling the
 * router, so the list never loads or paints on the way in. Call it before
 * the router is created; it patches and returns the same history object.
 */
export function keepBotsBehindChats(history: RouterHistory): RouterHistory {
  const basePush = history.push;
  const baseReplace = history.replace;
  const baseBlock = history.block;
  const blockers = new Set<NavigationBlocker>();

  // Rewrites the current entry as `path` with the router unsubscribed. The
  // flush commits it on its own: browser history coalesces a replace and a
  // push made in the same tick into one push, which would drop it.
  const writeEntryHere = (path: string, href: string, state: unknown) => {
    const subscribers = [...history.subscribers];
    history.subscribers.clear();
    try {
      baseReplace(href === "" ? path : href, state as never, { ignoreBlocker: true });
      history.flush();
    } finally {
      for (const subscriber of subscribers) history.subscribers.add(subscriber);
    }
  };
  const writeBotsHere = () => writeEntryHere(BOTS_PATH, "", undefined);

  // Blockers are checked here before /bots is written, since a blocked
  // navigation must leave the current entry as it was. Like the history
  // itself, they only run where there is a document.
  const allowed = async (href: string, state: unknown): Promise<boolean> => {
    if (typeof document === "undefined") return true;
    for (const blocker of blockers) {
      const blocked = await blocker.blockerFn({
        currentLocation: history.location,
        nextLocation: locationFor(href, state),
        action: "PUSH",
      });
      if (blocked) return false;
    }
    return true;
  };

  const navigate = (
    type: "push" | "replace",
    href: string,
    state: unknown,
    navigateOpts: NavigateOptions,
  ) => {
    const step = planStep(type, history.location, href);
    if (step.kind === "back") {
      history.back(navigateOpts);
      return;
    }
    const here = history.location;
    let teamView: TeamView | null = null;
    if (step.behind === "team") {
      if (isTeamPath(here.pathname)) {
        // Leaving the Team screen: remember how it looked on its own entry, so
        // Back puts it back (scroll, open members list).
        teamView = captureTeamView();
        if (teamView !== null) {
          writeEntryHere(here.pathname, here.href, {
            ...stateOf(here.state),
            [TEAM_VIEW_STATE_KEY]: teamView,
          });
        }
      } else {
        teamView = parseTeamView(stateOf(here.state)[TEAM_VIEW_STATE_KEY]);
      }
    }
    const nextState = withBehind(state, step.behind, teamView);
    const commit = step.kind === "push" ? basePush : baseReplace;
    if (!step.insertBots) {
      commit(href, nextState, navigateOpts);
      return;
    }
    const insert = () => {
      writeBotsHere();
      commit(href, nextState, { ...navigateOpts, ignoreBlocker: true });
    };
    if (navigateOpts?.ignoreBlocker || blockers.size === 0) {
      insert();
      return;
    }
    void allowed(href, nextState).then((ok) => {
      if (ok) insert();
    });
  };

  history.push = (href, state, navigateOpts) => navigate("push", href, state, navigateOpts);
  history.replace = (href, state, navigateOpts) => navigate("replace", href, state, navigateOpts);
  history.block = (blocker) => {
    blockers.add(blocker);
    const release = baseBlock(blocker);
    return () => {
      blockers.delete(blocker);
      release();
    };
  };

  // A chat opened cold (a deep link, a notification that started the app)
  // or from before this rule has nothing known behind it: put /bots there. A
  // chat the relaunch reopened from the Team screen gets the Team screen.
  const here = history.location;
  if (isPersonalChatPath(here.pathname) && behindOf(here) === null) {
    const record = stateOf(here.state);
    if (record[TEAM_RESUME_STATE_KEY] === true) {
      const view = parseTeamView(record[TEAM_VIEW_STATE_KEY]);
      writeEntryHere(TEAM_PATH, "", view === null ? undefined : { [TEAM_VIEW_STATE_KEY]: view });
      basePush(here.href, withBehind(here.state, "team", view), { ignoreBlocker: true });
    } else {
      writeBotsHere();
      basePush(here.href, withBehind(here.state, "bots", null), { ignoreBlocker: true });
    }
    history.flush();
  }

  return history;
}
