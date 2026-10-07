import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { backTargetOfState } from "./botsBackStack";
import { keepBotsBehindChats } from "./botsBackStack";
import {
  CHIP_EDGE_CLEARANCE,
  chatSwitchNavigation,
  scrollLeftToReveal,
} from "./chatChipNavigation";

// The same paths as the real tree (static segments win over the chat's params).
const PATHS = [
  "/bots",
  "/bots/team",
  "/bots/$botId",
  "/bots/$botId/edit",
  "/bots/$botId/$threadId",
  "/tasks",
  "/tasks/$taskId",
];

const BOT = "bot-cto";

function createTestRouter(initialEntries: string[]) {
  const history = keepBotsBehindChats(createMemoryHistory({ initialEntries }));
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

async function switchTo(router: TestRouter, threadId: string) {
  // The chips are Links with these exact options: the router navigates the same way.
  await router.navigate(chatSwitchNavigation(BOT, threadId) as never);
}

async function back(router: TestRouter) {
  router.history.back();
  await router.load();
  return router.state.location.pathname;
}

describe("chat chip switching", () => {
  it("asks for a replace, carrying the current history state", () => {
    const options = chatSwitchNavigation(BOT, "thread-b");
    expect(options.to).toBe("/bots/$botId/$threadId");
    expect(options.params).toEqual({ botId: BOT, threadId: "thread-b" });
    expect(options.replace).toBe(true);
    const previous = { personalBotsBehind: true, other: 1 };
    expect(options.state(previous)).toBe(previous);
  });

  it("replaces the chat's entry, so history never grows with each switch", async () => {
    const router = createTestRouter(["/bots"]);
    await router.load();
    await open(router, `/bots/${BOT}/thread-a`);
    const length = router.history.length;
    await switchTo(router, "thread-b");
    await switchTo(router, "thread-c");
    await switchTo(router, "thread-a");
    expect(router.state.location.pathname).toBe(`/bots/${BOT}/thread-a`);
    expect(router.history.length).toBe(length);
  });

  it("keeps Back on /bots after switching: one Back, then the Bots list", async () => {
    const router = createTestRouter(["/bots"]);
    await router.load();
    await open(router, `/bots/${BOT}/thread-a`);
    await switchTo(router, "thread-b");
    await switchTo(router, "thread-c");
    expect(router.state.location.pathname).toBe(`/bots/${BOT}/thread-c`);
    expect(backTargetOfState(router.state.location.state)).toBe("/bots");
    expect(await back(router)).toBe("/bots");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("keeps Back on the Team screen when the chat was opened from Team", async () => {
    const router = createTestRouter(["/bots/team"]);
    await router.load();
    await open(router, `/bots/${BOT}/thread-a`);
    expect(backTargetOfState(router.state.location.state)).toBe("/bots/team");
    await switchTo(router, "thread-b");
    await switchTo(router, "thread-c");
    expect(router.state.location.pathname).toBe(`/bots/${BOT}/thread-c`);
    expect(backTargetOfState(router.state.location.state)).toBe("/bots/team");
    expect(await back(router)).toBe("/bots/team");
    expect(router.history.canGoBack()).toBe(false);
  });

  it("keeps Back on /bots for a chat opened cold (a notification tap)", async () => {
    const router = createTestRouter([`/bots/${BOT}/thread-a`]);
    await router.load();
    await switchTo(router, "thread-b");
    expect(backTargetOfState(router.state.location.state)).toBe("/bots");
    expect(await back(router)).toBe("/bots");
  });

  it("keeps Back on /bots when the open chat came from a task page", async () => {
    const router = createTestRouter(["/bots"]);
    await router.load();
    await open(router, "/tasks/task-1");
    await open(router, `/bots/${BOT}/thread-a`);
    await switchTo(router, "thread-b");
    expect(await back(router)).toBe("/bots");
  });
});

describe("scrollLeftToReveal", () => {
  const row = (scrollLeft: number) => ({ scrollLeft, clientWidth: 300 });
  const chip = (offsetLeft: number) => ({ offsetLeft, offsetWidth: 80 });

  it("leaves a chip that is fully in view alone", () => {
    expect(scrollLeftToReveal(row(100), chip(200))).toBeNull();
    expect(scrollLeftToReveal(row(0), chip(3))).toBeNull();
  });

  it("brings a chip that moved to the front back to the start of the row", () => {
    expect(scrollLeftToReveal(row(420), chip(3))).toBe(0);
    // Partly hidden under the left fade counts as not in view.
    expect(scrollLeftToReveal(row(100), chip(110))).toBe(110 - CHIP_EDGE_CLEARANCE);
  });

  it("scrolls the nearest edge when the chip is off to the right", () => {
    expect(scrollLeftToReveal(row(0), chip(500))).toBe(500 + 80 + CHIP_EDGE_CLEARANCE - 300);
    // Cut off at the right edge, clear of the fade there.
    expect(scrollLeftToReveal(row(0), chip(250))).toBe(250 + 80 + CHIP_EDGE_CLEARANCE - 300);
  });

  it("never asks for a negative offset", () => {
    expect(scrollLeftToReveal(row(50), chip(10))).toBe(0);
  });
});
