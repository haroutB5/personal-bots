import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isPersonalChatPath, keepBotsBehindChats } from "./botsBackStack";

// The personal routes that matter here, with the same paths as the real tree:
// static segments (edit, groups, settings, new) win over the chat's params.
const PATHS = [
  "/bots",
  "/bots/new",
  "/bots/settings",
  "/bots/settings/memory",
  "/bots/groups/new",
  "/bots/teams/new",
  "/bots/groups/$groupId",
  "/bots/$botId",
  "/bots/$botId/edit",
  "/bots/$botId/$threadId",
  "/tasks",
  "/tasks/$taskId",
  "/files",
  "/computer",
];

const CHAT_A = "/bots/bot-1/thread-a";
const CHAT_B = "/bots/bot-2/thread-b";
const GROUP = "/bots/groups/group-1";

function createTestRouter(initialEntries: string[]) {
  const history = keepBotsBehindChats(createMemoryHistory({ initialEntries }));
  const root = createRootRoute();
  const routes = PATHS.map((path) => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history });
  // What the app's <Transitioner> does: the router loads on history changes.
  history.subscribe(router.load);
  return router;
}

type TestRouter = ReturnType<typeof createTestRouter>;

async function open(router: TestRouter, href: string, replace = false) {
  await router.navigate({ href, replace });
  expect(router.state.location.href).toBe(href);
}

async function back(router: TestRouter) {
  router.history.back();
  await router.load();
  return router.state.location.pathname;
}

async function forward(router: TestRouter) {
  router.history.forward();
  await router.load();
  return router.state.location.pathname;
}

/** Starts at /bots, then walks to each path in turn, like a person tapping. */
async function walk(...hrefs: string[]) {
  const router = createTestRouter(["/bots"]);
  await router.load();
  for (const href of hrefs) await open(router, href);
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPersonalChatPath", () => {
  it("matches bot chats and group chats only", () => {
    expect(isPersonalChatPath(CHAT_A)).toBe(true);
    expect(isPersonalChatPath(`${CHAT_A}/`)).toBe(true);
    expect(isPersonalChatPath(GROUP)).toBe(true);
    for (const path of [
      "/bots",
      "/bots/",
      "/bots/new",
      "/bots/bot-1",
      "/bots/bot-1/edit",
      "/bots/groups/new",
      "/bots/teams/new",
      "/bots/settings/memory",
      "/bots/settings/api-keys",
      "/tasks/task-1",
      "/environment-1/thread-1",
      "/bots/bot-1/thread-a/extra",
    ]) {
      expect(isPersonalChatPath(path), path).toBe(false);
    }
  });
});

describe("going back from a chat lands on /bots", () => {
  it("after Open chat on a task page, with the task page not in between", async () => {
    const router = await walk("/tasks", "/tasks/task-1", CHAT_A);
    expect(await back(router)).toBe("/bots");
    // The Bots page the chat sat on is the task page's old entry, so the
    // step before it is still the Tasks list the task was opened from.
    expect(await back(router)).toBe("/tasks");
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("after Open chat on a task card inside another chat", async () => {
    const router = await walk(CHAT_A, CHAT_B);
    expect(router.history.length).toBe(2);
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
    expect(await forward(router)).toBe(CHAT_B);
  });

  it("after a task page opened from a chat", async () => {
    const router = await walk(CHAT_A, "/tasks/task-1", CHAT_B);
    expect(await back(router)).toBe("/bots");
    // The task page's entry became that /bots; the first chat is behind it.
    expect(await back(router)).toBe(CHAT_A);
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it.each([
    ["the bot's chat list", "/bots/bot-1"],
    ["a group chat", GROUP],
    ["Files", "/files"],
    ["Computer", "/computer"],
    ["the Tasks list", "/tasks"],
    ["the bot's settings", "/bots/bot-1/edit"],
  ])("after a chat opened from %s", async (_label, from) => {
    const router = await walk(from, CHAT_A);
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("from a group chat opened from a task page", async () => {
    const router = await walk("/tasks/task-1", GROUP);
    expect(await back(router)).toBe("/bots");
  });

  it("from a cold deep link with no history behind it", async () => {
    const router = createTestRouter([CHAT_A]);
    await router.load();
    expect(router.state.location.pathname).toBe(CHAT_A);
    expect(await back(router)).toBe("/bots");
    expect(await forward(router)).toBe(CHAT_A);
  });

  it("after the chat replaces its own entry", async () => {
    const router = await walk("/tasks/task-1", CHAT_A);
    const length = router.history.length;
    await open(router, `${CHAT_A}?focus=1`, true);
    expect(router.history.length).toBe(length);
    expect(await back(router)).toBe("/bots");
  });

  it("after a chat created on the new chat page replaces it", async () => {
    const router = await walk("/bots/new");
    await open(router, CHAT_A, true);
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("from a tapped notification pushed straight onto history", async () => {
    const router = await walk("/tasks/task-1");
    router.history.push(CHAT_A);
    await router.load();
    expect(router.state.location.pathname).toBe(CHAT_A);
    expect(await back(router)).toBe("/bots");
  });
});

describe("the rest of history behaves normally", () => {
  it("opening a chat from /bots is a plain push, and back from /bots goes on", async () => {
    const router = createTestRouter(["/tasks", "/bots"]);
    await router.load();
    await open(router, CHAT_A);
    expect(router.history.length).toBe(3);
    expect(await back(router)).toBe("/bots");
    expect(await back(router)).toBe("/tasks");
    expect(await forward(router)).toBe("/bots");
    expect(await forward(router)).toBe(CHAT_A);
  });

  it("the chat's Back arrow to /bots steps back instead of stacking", async () => {
    const router = await walk("/tasks/task-1", CHAT_A);
    const length = router.history.length;
    await router.navigate({ href: "/bots" });
    await router.load();
    expect(router.state.location.pathname).toBe("/bots");
    expect(router.history.length).toBe(length);
    // Back from /bots goes where it went before the chat was opened.
    expect(await forward(router)).toBe(CHAT_A);
  });

  it("never loads /bots on the way into a chat", async () => {
    const router = await walk("/tasks", "/tasks/task-1");
    const seen: string[] = [];
    const stop = router.history.subscribe(({ location }) => seen.push(location.pathname));
    const loaded: string[] = [];
    const stopResolved = router.subscribe("onBeforeLoad", (event) => {
      loaded.push(event.toLocation.pathname);
    });
    await open(router, CHAT_A);
    stop();
    stopResolved();
    expect(seen).toEqual([CHAT_A]);
    expect(loaded).toEqual([CHAT_A]);
  });

  it("leaves history alone when a blocker stops the navigation", async () => {
    const router = await walk("/tasks", "/tasks/task-1");
    // Blockers only run where there is a document.
    vi.stubGlobal("document", {});
    const blockerFn = vi.fn(() => true);
    const release = router.history.block({ blockerFn });
    // A blocked navigation never settles, the same as without this rule.
    void router.navigate({ href: CHAT_A });
    await vi.waitFor(() => expect(blockerFn).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(router.history.location.pathname).toBe("/tasks/task-1");
    release();
    vi.unstubAllGlobals();
    expect(await back(router)).toBe("/tasks");
  });

  it("asks a blocker once and then keeps /bots behind the chat", async () => {
    const router = await walk("/tasks", "/tasks/task-1");
    vi.stubGlobal("document", {});
    const blockerFn = vi.fn(() => false);
    const release = router.history.block({ blockerFn });
    await router.navigate({ href: CHAT_A });
    release();
    vi.unstubAllGlobals();
    expect(blockerFn).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe(CHAT_A);
    expect(await back(router)).toBe("/bots");
  });
});
