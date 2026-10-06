import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ChatChips } from "./ChatChips";
import type { ChatChip } from "./chatChipRows";

const chip = (threadId: string, pinned: boolean, current = false): ChatChip => ({
  threadId,
  text: `Chat ${threadId}`,
  kind: "chat",
  current,
  state: "idle",
  unread: false,
  pinned,
  label: pinned ? `Chat ${threadId}, pinned` : `Chat ${threadId}`,
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderChips(chips: ChatChip[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRootRoute({
    component: () => (
      <ChatChips
        botId="b1"
        botName="Backend"
        chips={chips}
        openCount={chips.length}
        onNewChat={() => {}}
      />
    ),
  });
  const routes = ["/bots/$botId", "/bots/$botId/$threadId"].map((path) =>
    createRoute({ getParentRoute: () => root, path }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/bots/b1/t1"] }),
  });
  await router.load();
  await act(async () => {
    renderer = create(<RouterProvider router={router} />, {
      createNodeMock: () => ({
        clientWidth: 300,
        scrollLeft: 0,
        scrollWidth: 300,
        scrollTo: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
      }),
    });
  });
  return renderer!;
}

it("draws a small pin on a pinned chat's chip and on no other", async () => {
  const tree = await renderChips([chip("t1", true, true), chip("t2", false), chip("t3", true)]);
  const links = tree.root.findAll((node) => node.type === "a" && node.props["data-chip-id"]);
  const pinsIn = (link: (typeof links)[number]) =>
    link.findAll((node) => node.type === "svg" && node.props["data-chip-pin"] === "");
  expect(links.map((link) => pinsIn(link).length)).toEqual([1, 0, 1]);
});

it("a pinned chip is also named as pinned for a screen reader", async () => {
  const tree = await renderChips([chip("t1", true, true), chip("t2", false)]);
  const labels = tree.root
    .findAll((node) => node.type === "a" && node.props["data-chip-id"])
    .map((link) => link.props["aria-label"]);
  expect(labels).toEqual(["Chat t1, pinned", "Chat t2"]);
});
