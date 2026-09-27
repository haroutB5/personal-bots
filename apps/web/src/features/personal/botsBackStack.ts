import type { RouterHistory } from "@tanstack/react-router";

type HistoryLocation = RouterHistory["location"];
type NavigationBlocker = Parameters<RouterHistory["block"]>[0];
type NavigateOptions = Parameters<RouterHistory["push"]>[2];

const BOTS_PATH = "/bots";

/**
 * Set on a history entry when the entry directly behind it is /bots. It lives
 * in the browser's history state, so it survives reloads and back/forward.
 */
export const BOTS_BEHIND_STATE_KEY = "personalBotsBehind";

const CHAT_PATH = /^\/bots\/([^/]+)\/([^/]+)\/?$/;

/** A bot chat (/bots/$botId/$threadId) or a group chat (/bots/groups/$groupId). */
export function isPersonalChatPath(pathname: string): boolean {
  const match = CHAT_PATH.exec(pathname);
  if (match === null) return false;
  const [, first, second] = match;
  if (first === "groups") return second !== "new";
  return first !== "settings" && second !== "edit";
}

function isBotsPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === BOTS_PATH;
}

function splitHref(href: string): { pathname: string; rest: string } {
  const end = href.search(/[?#]/);
  return end === -1
    ? { pathname: href, rest: "" }
    : { pathname: href.slice(0, end), rest: href.slice(end) };
}

function hasBotsBehind(location: HistoryLocation): boolean {
  return (location.state as unknown as Record<string, unknown>)[BOTS_BEHIND_STATE_KEY] === true;
}

function withBotsBehind(state: unknown, botsBehind: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(state as Record<string, unknown> | undefined) };
  if (botsBehind) next[BOTS_BEHIND_STATE_KEY] = true;
  else delete next[BOTS_BEHIND_STATE_KEY];
  return next;
}

type Step =
  | { kind: "back" }
  | { kind: "push" | "replace"; botsBehind: boolean; insertBots: boolean };

function planStep(type: "push" | "replace", current: HistoryLocation, href: string): Step {
  const dest = splitHref(href);
  const botsBehind = hasBotsBehind(current);
  if (isPersonalChatPath(dest.pathname)) {
    // /bots is already behind this entry: the chat takes its place, so a
    // chat opened from a chat, a task page or a bot's list never stacks.
    if (botsBehind) return { kind: "replace", botsBehind: true, insertBots: false };
    if (isBotsPath(current.pathname)) return { kind: "push", botsBehind: true, insertBots: false };
    // Anywhere else: this entry becomes /bots and the chat goes on top.
    return { kind: "push", botsBehind: true, insertBots: true };
  }
  // Going to /bots when it sits right behind (a chat's Back arrow, the Bots
  // tab) steps back, so history does not grow a /bots -> chat -> /bots loop.
  if (type === "push" && isBotsPath(dest.pathname) && dest.rest === "" && botsBehind) {
    return { kind: "back" };
  }
  return type === "push"
    ? { kind: "push", botsBehind: isBotsPath(current.pathname), insertBots: false }
    : { kind: "replace", botsBehind, insertBots: false };
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

  // Rewrites the current entry as /bots with the router unsubscribed. The
  // flush commits it on its own: browser history coalesces a replace and a
  // push made in the same tick into one push, which would drop it.
  const writeBotsHere = () => {
    const subscribers = [...history.subscribers];
    history.subscribers.clear();
    try {
      baseReplace(BOTS_PATH, undefined, { ignoreBlocker: true });
      history.flush();
    } finally {
      for (const subscriber of subscribers) history.subscribers.add(subscriber);
    }
  };

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
    const nextState = withBotsBehind(state, step.botsBehind);
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
  // or from before this rule has nothing known behind it: put /bots there.
  const here = history.location;
  if (isPersonalChatPath(here.pathname) && !hasBotsBehind(here)) {
    writeBotsHere();
    basePush(here.href, withBotsBehind(here.state, true), { ignoreBlocker: true });
    history.flush();
  }

  return history;
}
