import {
  type RouterHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  backTargetOfState,
  behindOfState,
  BOTS_BEHIND_STATE_KEY,
  isTeamOpenedPath,
  keepBotsBehindChats,
  TEAM_BEHIND_STATE_KEY,
  TEAM_RESUME_STATE_KEY,
  TEAM_VIEW_STATE_KEY,
} from "./botsBackStack";
import { registerTeamViewSource, type TeamView } from "./teamView";

// The same paths as the real tree (static segments win over the chat's params).
const PATHS = [
  "/bots",
  "/bots/new",
  "/bots/team",
  "/bots/settings",
  "/bots/teams/new",
  "/bots/groups/$groupId",
  "/bots/$botId",
  "/bots/$botId/edit",
  "/bots/$botId/$threadId",
  "/tasks",
  "/tasks/$taskId",
];

const TEAM = "/bots/team";
const BOT = "/bots/bot-cto";
const EDIT = "/bots/bot-cto/edit";
const CHAT = "/bots/bot-cto/thread-a";
const OTHER_CHAT = "/bots/bot-qa/thread-b";
const GROUP = "/bots/groups/group-1";
const VIEW: TeamView = {
  scrollTop: 640,
  anchorTeam: "Finance",
  anchorOffset: 42,
  membersTeam: "dev",
};

function createTestRouter(initialEntries: string[], prepare?: (base: RouterHistory) => void) {
  const base = createMemoryHistory({ initialEntries });
  prepare?.(base);
  const history = keepBotsBehindChats(base);
  const root = createRootRoute();
  const routes = PATHS.map((path) => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history });
  history.subscribe(router.load);
  return router;
}

type TestRouter = ReturnType<typeof createTestRouter>;

async function open(router: TestRouter, href: string) {
  await router.navigate({ href });
  expect(router.state.location.href).toBe(href);
}

async function back(router: TestRouter) {
  router.history.back();
  await router.load();
  return router.state.location.pathname;
}

/** Starts at the given page, then walks to each path in turn, like a person tapping. */
async function walk(start: string, ...hrefs: string[]) {
  const router = createTestRouter([start]);
  await router.load();
  for (const href of hrefs) await open(router, href);
  return router;
}

const state = (router: TestRouter) =>
  router.state.location.state as unknown as Record<string, unknown>;

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("isTeamOpenedPath", () => {
  it("is a bot's page, its edit form, a bot chat and a task page", () => {
    expect(isTeamOpenedPath(BOT)).toBe(true);
    expect(isTeamOpenedPath(`${BOT}/`)).toBe(true);
    expect(isTeamOpenedPath(EDIT)).toBe(true);
    expect(isTeamOpenedPath(CHAT)).toBe(true);
    expect(isTeamOpenedPath("/tasks/task-1")).toBe(true);
  });

  it("is nothing else", () => {
    for (const path of [
      "/bots",
      TEAM,
      "/bots/new",
      "/bots/settings",
      "/bots/teams/new",
      "/bots/settings/memory",
      GROUP,
      "/bots/groups/new",
      "/tasks",
      "/tasks/routines/new",
      "/files",
    ]) {
      expect(isTeamOpenedPath(path)).toBe(false);
    }
  });
});

describe("behindOfState / backTargetOfState", () => {
  it("tells the Team screen from the Bots list", () => {
    expect(behindOfState({ [TEAM_BEHIND_STATE_KEY]: true })).toBe("team");
    expect(behindOfState({ [BOTS_BEHIND_STATE_KEY]: true })).toBe("bots");
    expect(behindOfState(undefined)).toBe(null);
    expect(backTargetOfState({ [TEAM_BEHIND_STATE_KEY]: true })).toBe("/bots/team");
    expect(backTargetOfState({ [BOTS_BEHIND_STATE_KEY]: true })).toBe("/bots");
    expect(backTargetOfState(null)).toBe("/bots");
  });
});

describe("Back from anything opened on the Team screen returns to it", () => {
  it("from a bot's page: the arrow and browser Back", async () => {
    const router = await walk(TEAM, BOT);
    expect(state(router)[TEAM_BEHIND_STATE_KEY]).toBe(true);
    // The arrow is a link to the Team screen: it steps back, no loop.
    await open(router, TEAM);
    expect(router.state.location.pathname).toBe(TEAM);
    expect(router.history.canGoBack()).toBe(false);

    await open(router, BOT);
    expect(await back(router)).toBe(TEAM);
  });

  it("from a bot chat opened from the bot's page", async () => {
    const router = await walk(TEAM, BOT, CHAT);
    // The chat takes the bot page's entry: one step, and the Team screen is right behind.
    expect(router.history.length).toBe(2);
    expect(state(router)[TEAM_BEHIND_STATE_KEY]).toBe(true);
    expect(await back(router)).toBe(TEAM);
    expect(router.history.canGoBack()).toBe(false);
  });

  it("from the edit form opened from the bot's page", async () => {
    const router = await walk(TEAM, BOT, EDIT);
    expect(router.history.length).toBe(2);
    expect(await back(router)).toBe(TEAM);
  });

  it("from a Working now task chat", async () => {
    const router = await walk(TEAM, CHAT);
    expect(await back(router)).toBe(TEAM);
    expect(router.history.canGoBack()).toBe(false);
  });

  it("from a task page (a Working now row whose task has no chat yet)", async () => {
    const router = await walk(TEAM, "/tasks/task-1");
    expect(await back(router)).toBe(TEAM);
  });

  it("from a chat opened from a chat, and from the chat's Back arrow", async () => {
    const router = await walk(TEAM, CHAT, OTHER_CHAT);
    expect(router.history.length).toBe(2);
    await open(router, TEAM);
    expect(router.state.location.pathname).toBe(TEAM);
    expect(router.history.canGoBack()).toBe(false);
  });

  it("never loads the Bots list on the way", async () => {
    const router = await walk(TEAM, BOT, CHAT);
    expect(router.state.matches.some((match) => match.routeId === "/bots")).toBe(false);
    expect(await back(router)).toBe(TEAM);
  });

  it("with Forward returning to the page", async () => {
    const router = await walk(TEAM, CHAT);
    await back(router);
    router.history.forward();
    await router.load();
    expect(router.state.location.pathname).toBe(CHAT);
  });
});

describe("everything else still goes to /bots", () => {
  it("a chat from the Bots list", async () => {
    const router = await walk("/bots", CHAT);
    expect(state(router)[TEAM_BEHIND_STATE_KEY]).toBeUndefined();
    expect(await back(router)).toBe("/bots");
  });

  it("a bot's page opened from the Bots list, and its chat", async () => {
    const router = await walk("/bots", BOT, CHAT);
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("a chat opened from a task page", async () => {
    const router = await walk("/tasks", "/tasks/task-1", CHAT);
    expect(await back(router)).toBe("/bots");
  });

  it("a chat opened cold has /bots put behind it", async () => {
    const router = createTestRouter([CHAT]);
    await router.load();
    expect(await back(router)).toBe("/bots");
  });

  it("a group chat opened from the Team screen", async () => {
    const router = await walk(TEAM, GROUP);
    expect(state(router)[TEAM_BEHIND_STATE_KEY]).toBeUndefined();
    expect(await back(router)).toBe("/bots");
  });

  it("the New team form opened from the Team screen keeps its own Back", async () => {
    const router = await walk(TEAM, "/bots/teams/new");
    expect(state(router)[TEAM_BEHIND_STATE_KEY]).toBeUndefined();
    expect(await back(router)).toBe(TEAM);
  });

  it("the Bots tab from a page the Team screen opened is a plain push", async () => {
    const router = await walk(TEAM, CHAT, "/bots");
    expect(state(router)[TEAM_BEHIND_STATE_KEY]).toBeUndefined();
    expect(await back(router)).toBe(CHAT);
  });
});

describe("the Team screen comes back as it was left", () => {
  it("stamps the view on the Team entry and copies it onto what opens from it", async () => {
    unregister = registerTeamViewSource(() => VIEW);
    const router = await walk(TEAM, BOT, CHAT);
    expect(state(router)[TEAM_VIEW_STATE_KEY]).toEqual(VIEW);
    expect(await back(router)).toBe(TEAM);
    expect(state(router)[TEAM_VIEW_STATE_KEY]).toEqual(VIEW);
  });

  it("a fresh visit to the Team screen carries no view", async () => {
    unregister = registerTeamViewSource(() => VIEW);
    const router = await walk("/bots", TEAM);
    expect(state(router)[TEAM_VIEW_STATE_KEY]).toBeUndefined();
  });

  it("with no Team screen on show, Back still lands on it", async () => {
    const router = await walk(TEAM, CHAT);
    expect(state(router)[TEAM_VIEW_STATE_KEY]).toBeUndefined();
    expect(await back(router)).toBe(TEAM);
  });
});

describe("a chat reopened after iOS ended the app", () => {
  it("gets the Team screen behind it, with its view", async () => {
    // What resumeLastChatAtBoot writes: the entry becomes the chat, marked.
    const router = createTestRouter(["/bots"], (base) =>
      base.replace(CHAT, { [TEAM_RESUME_STATE_KEY]: true, [TEAM_VIEW_STATE_KEY]: VIEW } as never),
    );
    await router.load();
    expect(state(router)[TEAM_BEHIND_STATE_KEY]).toBe(true);
    expect(state(router)[TEAM_RESUME_STATE_KEY]).toBeUndefined();
    expect(await back(router)).toBe(TEAM);
    expect(state(router)[TEAM_VIEW_STATE_KEY]).toEqual(VIEW);
    expect(router.history.canGoBack()).toBe(false);
  });
});
