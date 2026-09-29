import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { keepBotsBehindChats, TEAM_VIEW_STATE_KEY } from "./botsBackStack";
import {
  LAST_CHAT_MAX_AGE_MS,
  LAST_CHAT_STORAGE_KEY,
  leaveResumedChatIfGone,
  readLastChat,
  resumeLastChatAtBoot,
  resumedChatPath,
  trackLastChat,
} from "./resumeLastChat";
import { registerTeamViewSource } from "./teamView";

const PATHS = [
  "/",
  "/bots",
  "/bots/team",
  "/bots/settings",
  "/bots/groups/$groupId",
  "/bots/$botId",
  "/bots/$botId/$threadId",
  "/tasks",
  "/tasks/$taskId",
];

const CHAT_A = "/bots/bot-1/thread-a";
const CHAT_B = "/bots/bot-2/thread-b";
const GROUP = "/bots/groups/group-1";
const NOW = 1_800_000_000_000;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

function saved(path: string, at = NOW - 5 * 60_000) {
  return { [LAST_CHAT_STORAGE_KEY]: JSON.stringify({ path, at }) };
}

/** What main.tsx does on a launch, with a memory history standing in for the address bar. */
async function launch(
  url: string,
  storage: ReturnType<typeof memoryStorage>,
  { standalone = true, now = NOW } = {},
) {
  const base = createMemoryHistory({ initialEntries: [url] });
  const resumed = resumeLastChatAtBoot(base, { storage, now, standalone });
  const history = keepBotsBehindChats(base);
  let clock = now;
  trackLastChat(history, { storage, now: () => clock });
  const root = createRootRoute();
  const routes = PATHS.map((path) => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history });
  const painted: string[] = [];
  history.subscribe(() => void router.load());
  await router.load();
  painted.push(router.state.location.pathname);
  return {
    router,
    resumed,
    painted,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

async function back(router: Awaited<ReturnType<typeof launch>>["router"]) {
  router.history.back();
  await router.load();
  return router.state.location.pathname;
}

describe("a relaunch at /bots reopens the chat that was left", () => {
  it("opens the saved bot chat straight away, with /bots behind it", async () => {
    const storage = memoryStorage(saved(CHAT_A));
    const { router, resumed, painted } = await launch("/bots", storage);
    expect(resumed).toBe(CHAT_A);
    // The first thing the router ever loads is the chat: no Bots list flash.
    expect(painted).toEqual([CHAT_A]);
    expect(router.history.length).toBe(2);
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("reopens a group chat the same way", async () => {
    const { router } = await launch("/bots", memoryStorage(saved(GROUP)));
    expect(router.state.location.pathname).toBe(GROUP);
    expect(await back(router)).toBe("/bots");
  });

  it("the chat's Back arrow (navigate to /bots) steps back instead of stacking", async () => {
    const { router } = await launch("/bots", memoryStorage(saved(CHAT_A)));
    await router.navigate({ to: "/bots" });
    expect(router.state.location.pathname).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("also from an older Home Screen icon that opens /", async () => {
    const { router } = await launch("/", memoryStorage(saved(CHAT_A)));
    expect(router.state.location.pathname).toBe(CHAT_A);
    expect(await back(router)).toBe("/bots");
  });

  it("leaves the browser tab alone: only the installed app relaunches at /bots", async () => {
    const { router, resumed } = await launch("/bots", memoryStorage(saved(CHAT_A)), {
      standalone: false,
    });
    expect(resumed).toBeNull();
    expect(router.state.location.pathname).toBe("/bots");
  });
});

describe("a chat opened from the Team screen goes back to it after a relaunch", () => {
  const VIEW = { scrollTop: 500, anchorTeam: "Finance", anchorOffset: 30, membersTeam: null };

  it("saves where the chat was opened from, and the relaunch puts the Team screen behind it", async () => {
    const storage = memoryStorage();
    const first = await launch("/bots/team", storage);
    registerTeamViewSource(() => VIEW);
    await first.router.navigate({ href: "/bots/bot-1" });
    await first.router.navigate({ href: CHAT_A });
    expect(JSON.parse(storage.data.get(LAST_CHAT_STORAGE_KEY) ?? "{}")).toMatchObject({
      path: CHAT_A,
      team: true,
      teamView: VIEW,
    });

    // iOS ends the app; the icon opens /bots.
    const second = await launch("/bots", storage);
    expect(second.resumed).toBe(CHAT_A);
    expect(second.painted).toEqual([CHAT_A]);
    expect(await back(second.router)).toBe("/bots/team");
    expect(
      (second.router.state.location.state as unknown as Record<string, unknown>)[
        TEAM_VIEW_STATE_KEY
      ],
    ).toEqual(VIEW);
    expect(second.router.history.canGoBack()).toBe(false);
  });

  it("a chat opened from the Bots list still goes back to /bots", async () => {
    const storage = memoryStorage();
    const first = await launch("/bots", storage);
    await first.router.navigate({ href: CHAT_A });
    expect(JSON.parse(storage.data.get(LAST_CHAT_STORAGE_KEY) ?? "{}").team).toBeUndefined();
    const second = await launch("/bots", storage);
    expect(await back(second.router)).toBe("/bots");
  });

  it("the resumed chat's own Back arrow to the Team screen steps back onto it", async () => {
    const storage = memoryStorage();
    const first = await launch("/bots/team", storage);
    await first.router.navigate({ href: CHAT_A });
    const second = await launch("/bots", storage);
    await second.router.navigate({ to: "/bots/team" });
    expect(second.router.state.location.pathname).toBe("/bots/team");
    expect(second.router.history.canGoBack()).toBe(false);
  });
});

describe("anything else the app was opened for wins", () => {
  it.each([
    ["a notification tap on another chat", CHAT_B],
    ["a notification tap on a task", "/tasks/task-1"],
    ["a deep link to a bot's chat list", "/bots/bot-1"],
    ["/bots with a query", "/bots?tab=groups"],
  ])("%s", async (_label, url) => {
    const storage = memoryStorage(saved(CHAT_A));
    const { router, resumed } = await launch(url, storage);
    expect(resumed).toBeNull();
    expect(router.state.location.href).toBe(url);
  });

  it("a tap that arrives after the boot (saved copy) replaces the reopened chat", async () => {
    const { router } = await launch("/bots", memoryStorage(saved(CHAT_A)));
    await router.navigate({ href: CHAT_B });
    expect(router.state.location.pathname).toBe(CHAT_B);
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });
});

describe("stale or gone chats fall back to /bots", () => {
  it("does not reopen a chat left longer than the expiry ago, and forgets it", async () => {
    const storage = memoryStorage(saved(CHAT_A, NOW - LAST_CHAT_MAX_AGE_MS - 1));
    const { router, resumed } = await launch("/bots", storage);
    expect(resumed).toBeNull();
    expect(router.state.location.pathname).toBe("/bots");
    expect(storage.data.has(LAST_CHAT_STORAGE_KEY)).toBe(false);
  });

  it("ignores a saved entry that is not a chat or is unreadable", () => {
    expect(readLastChat(memoryStorage(saved("/tasks/task-1")), NOW)).toBeNull();
    expect(readLastChat(memoryStorage({ [LAST_CHAT_STORAGE_KEY]: "{oops" }), NOW)).toBeNull();
    expect(readLastChat(memoryStorage(saved(CHAT_A, NOW + 60_000)), NOW)).toBeNull();
    expect(readLastChat(null, NOW)).toBeNull();
  });

  it("a reopened chat deleted or archived since goes quietly back to /bots", async () => {
    const storage = memoryStorage(saved(CHAT_A));
    const { router } = await launch("/bots", storage);
    expect(resumedChatPath()).toBe(CHAT_A);
    expect(leaveResumedChatIfGone(CHAT_A, false, () => undefined)).toBe(false);
    const left = leaveResumedChatIfGone(CHAT_A, true, () => void router.navigate({ to: "/bots" }));
    expect(left).toBe(true);
    await router.load();
    expect(router.state.location.pathname).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
    // Nothing left to reopen on the next launch.
    expect(storage.data.has(LAST_CHAT_STORAGE_KEY)).toBe(false);
  });

  it("a chat opened any other way keeps its own deleted message", async () => {
    await launch(CHAT_A, memoryStorage());
    expect(resumedChatPath()).toBeNull();
    expect(leaveResumedChatIfGone(CHAT_A, true, () => undefined)).toBe(false);
  });
});

describe("only the chat on screen when the app was left is remembered", () => {
  it("going to any non-chat page forgets the chat", async () => {
    const storage = memoryStorage();
    const first = await launch("/bots", storage);
    await first.router.navigate({ href: CHAT_A });
    expect(readLastChat(storage, NOW)).toBe(CHAT_A);
    await first.router.navigate({ href: "/tasks" });
    expect(storage.data.has(LAST_CHAT_STORAGE_KEY)).toBe(false);
    // Left from Tasks: the next relaunch stays on /bots.
    const next = await launch("/bots", storage);
    expect(next.resumed).toBeNull();
    expect(next.router.state.location.pathname).toBe("/bots");
  });

  it("going back to Bots from the chat forgets it", async () => {
    const storage = memoryStorage();
    const { router } = await launch("/bots", storage);
    await router.navigate({ href: CHAT_A });
    await back(router);
    expect(storage.data.has(LAST_CHAT_STORAGE_KEY)).toBe(false);
  });

  it("a chat opened from a notification is the one saved", async () => {
    const storage = memoryStorage(saved(CHAT_A));
    await launch(CHAT_B, storage);
    expect(readLastChat(storage, NOW)).toBe(CHAT_B);
  });

  it("hiding the app restamps the time it was left", async () => {
    const storage = memoryStorage();
    const listeners = new Map<string, () => void>();
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
    };
    const base = createMemoryHistory({ initialEntries: [CHAT_A] });
    let clock = NOW;
    trackLastChat(keepBotsBehindChats(base), {
      storage,
      now: () => clock,
      document: doc as unknown as Document,
    });
    clock = NOW + 60 * 60_000;
    doc.visibilityState = "hidden";
    listeners.get("visibilitychange")?.();
    const stamp = JSON.parse(storage.getItem(LAST_CHAT_STORAGE_KEY)!) as { at: number };
    expect(stamp.at).toBe(NOW + 60 * 60_000);
  });
});
