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
import { CURRENT_CHIP_SELECTOR } from "./chatChipNavigation";
import type { ChatChip } from "./chatChipRows";

const chip = (threadId: string, current: boolean): ChatChip => ({
  threadId,
  text: `Chat ${threadId}`,
  kind: "chat",
  current,
  state: "idle",
  unread: false,
  pinned: false,
  label: current ? `Chat ${threadId}, current chat` : `Chat ${threadId}`,
});

const OFFSETS: Record<string, number> = { t1: 0, t2: 250, t3: 500 };
const CHIP_WIDTH = 80;
const ROW_WIDTH = 300;

interface FakeAnchor {
  readonly offsetLeft: number;
  readonly offsetWidth: number;
  readonly props: Record<string, unknown>;
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

/** Renders the chips on the chat route of a real router, with the row's DOM faked from what React made. */
async function renderChips(href: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const anchors: FakeAnchor[] = [];
  const scrollTo = vi.fn();
  const row = {
    clientWidth: ROW_WIDTH,
    scrollLeft: 0,
    scrollWidth: 800,
    scrollTo,
    // The centring effect asks for the current chip by this exact selector.
    querySelector: (selector: string) =>
      selector === CURRENT_CHIP_SELECTOR
        ? (anchors.find((anchor) => anchor.props["aria-current"] === "page") ?? null)
        : null,
    querySelectorAll: () => [],
  };
  const root = createRootRoute({
    component: () => (
      <ChatChips
        botId="b1"
        botName="Backend"
        chips={[chip("t1", false), chip("t2", true), chip("t3", false)]}
        openCount={3}
        onNewChat={() => {}}
      />
    ),
  });
  const routes = ["/bots/$botId", "/bots/$botId/$threadId"].map((path) =>
    createRoute({ getParentRoute: () => root, path }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  await router.load();
  await act(async () => {
    renderer = create(<RouterProvider router={router} />, {
      createNodeMock: (element) => {
        if (element.type === "a") {
          const props = element.props as Record<string, unknown>;
          const anchor: FakeAnchor = {
            offsetLeft: OFFSETS[String(props["data-chip-id"])] ?? 0,
            offsetWidth: CHIP_WIDTH,
            props,
          };
          anchors.push(anchor);
          return anchor;
        }
        return element.type === "div" ? row : null;
      },
    });
  });
  return { tree: renderer!, scrollTo };
}

it("marks only the open chat's chip as the current page, not the All link", async () => {
  const { tree } = await renderChips("/bots/b1/t2");
  const current = tree.root.findAll(
    (node) => typeof node.type === "string" && node.props["aria-current"] === "page",
  );
  expect(current.map((node) => node.props["data-chip-id"])).toEqual(["t2"]);
  const all = tree.root.findAll(
    (node) =>
      node.type === "a" && String(node.props["aria-label"]).startsWith("All chats with Backend"),
  );
  expect(all).toHaveLength(1);
  expect(all[0]!.props["aria-current"]).toBeUndefined();
  expect(all[0]!.props["data-status"]).toBeUndefined();
});

it("still centres the row on the current chip", async () => {
  const { scrollTo } = await renderChips("/bots/b1/t2");
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo).toHaveBeenCalledWith({
    left: 250 - (ROW_WIDTH - CHIP_WIDTH) / 2,
    behavior: "instant",
  });
});
