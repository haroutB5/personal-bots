import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { keepBotsBehindChats } from "./botsBackStack";
import { openedSheetHere, useUsageSheetRoute, usageBotOfLocation } from "./usageSheetRoute";

type SheetRoute = ReturnType<typeof useUsageSheetRoute>;

let latest: SheetRoute | undefined;

function Probe() {
  latest = useUsageSheetRoute();
  return null;
}

function createTestRouter(initialEntries: string[]) {
  const history = keepBotsBehindChats(createMemoryHistory({ initialEntries }));
  const root = createRootRoute();
  const team = createRoute({
    getParentRoute: () => root,
    path: "/bots/team",
    validateSearch: (search: Record<string, unknown>): { usage?: string } =>
      typeof search.usage === "string" && search.usage !== "" ? { usage: search.usage } : {},
    component: Probe,
  });
  const routes = ["/bots", "/bots/$botId", "/bots/$botId/$threadId"].map((path) =>
    createRoute({ getParentRoute: () => root, path }),
  );
  const router = createRouter({
    routeTree: root.addChildren([team, ...routes]),
    history,
  });
  history.subscribe(router.load);
  return router;
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  latest = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(initialEntries: string[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const router = createTestRouter(initialEntries);
  await act(async () => {
    renderer = create(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}

const settle = async (router: ReturnType<typeof createTestRouter>) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await router.load();
  });
};

describe("usageBotOfLocation", () => {
  it("names the bot only on the Team screen", () => {
    expect(usageBotOfLocation({ pathname: "/bots/team", search: { usage: "fe" } })).toBe("fe");
    expect(usageBotOfLocation({ pathname: "/bots/team/", search: { usage: "fe" } })).toBe("fe");
    expect(usageBotOfLocation({ pathname: "/bots/team", search: {} })).toBeNull();
    expect(usageBotOfLocation({ pathname: "/bots/team", search: { usage: "" } })).toBeNull();
    expect(usageBotOfLocation({ pathname: "/bots/team", search: { usage: 3 } })).toBeNull();
    expect(usageBotOfLocation({ pathname: "/bots", search: { usage: "fe" } })).toBeNull();
  });

  it("tells an entry pushed for the sheet from any other", () => {
    expect(openedSheetHere({ personalUsageSheet: true })).toBe(true);
    expect(openedSheetHere({})).toBe(false);
    expect(openedSheetHere(null)).toBe(false);
    expect(openedSheetHere(undefined)).toBe(false);
  });
});

// These run in node, where the router renders like a server and the hooks read
// the location once instead of subscribing; the actions below do not depend on
// that, they drive the real router and history. The live subscription is
// checked in the browser run.
describe("useUsageSheetRoute", () => {
  it("opens by pushing ?usage and Back closes it, staying on Team", async () => {
    const router = await mount(["/bots", "/bots/team"]);

    await act(async () => latest!.open("fe"));
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots/team");
    expect(router.state.location.search).toEqual({ usage: "fe" });

    router.history.back();
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots/team");
    expect(router.state.location.search).toEqual({});
  });

  it("closes by stepping back, so no second Team entry is stacked", async () => {
    const router = await mount(["/bots", "/bots/team"]);
    await act(async () => latest!.open("fe"));
    const depth = router.history.length;
    await act(async () => latest!.close());
    await settle(router);
    expect(router.state.location.search).toEqual({});
    expect(router.history.length).toBeLessThanOrEqual(depth);
    // One more Back leaves Team for the page before it.
    router.history.back();
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots");
  });

  it("closes a deep-linked sheet by replacing, never leaving Team", async () => {
    const router = await mount(["/bots/team?usage=fe"]);
    await act(async () => latest!.close());
    await settle(router);
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots/team");
    expect(router.state.location.search).toEqual({});
    expect(router.history.canGoBack()).toBe(false);
  });

  it("opens the chat from the Team entry, and Back from the chat returns to Team without the sheet", async () => {
    const router = await mount(["/bots", "/bots/team"]);
    await act(async () => latest!.open("fe"));
    await act(async () => latest!.openChat("fe"));
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots/fe");

    router.history.back();
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots/team");
    expect(router.state.location.search).toEqual({});
  });

  it("opens the chat from a deep-linked sheet too, and Back lands on Team", async () => {
    const router = await mount(["/bots/team?usage=fe"]);
    await act(async () => latest!.openChat("fe"));
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots/fe");

    router.history.back();
    await settle(router);
    expect(router.state.location.pathname).toBe("/bots/team");
    expect(router.state.location.search).toEqual({});
  });
});
