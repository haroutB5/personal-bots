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
import { ConversationShellHeader } from "./ConversationShellFirst";

// The chat header's data hooks are faked; the router, the Back link and the chip row are real.
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./botModelLabel", () => ({ botModelShortLabel: () => "Sonnet 5.5 · M" }));
vi.mock("./usePersonalBackTarget", () => ({
  usePersonalBackTarget: () => ({ to: "/bots", label: "Back to Bots" }),
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: {
      bots: [
        {
          botId: "b1",
          name: "Backend",
          avatarShape: "pill",
          avatarColor: "#E8711A",
          modelSelection: {},
        },
      ],
    },
  }),
}));

const chip = (threadId: string, current: boolean): ChatChip => ({
  threadId,
  text: `Chat ${threadId}`,
  kind: "chat",
  current,
  state: "idle",
  unread: false,
  label: current ? `Chat ${threadId}, current chat` : `Chat ${threadId}`,
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

/** The chat header on the chat route: the first-frame header (Back link, name), then the strip if it shows. */
async function renderChatHeader(chips: ReadonlyArray<ChatChip>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRootRoute({
    component: () => (
      <>
        <ConversationShellHeader botId="b1" />
        {chips.length >= 2 ? (
          <ChatChips
            botId="b1"
            botName="Backend"
            chips={chips}
            openCount={chips.length}
            onNewChat={() => {}}
          />
        ) : null}
      </>
    ),
  });
  const routes = ["/bots", "/bots/$botId", "/bots/$botId/$threadId"].map((path) =>
    createRoute({ getParentRoute: () => root, path }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/bots/b1/t2"] }),
  });
  await router.load();
  await act(async () => {
    renderer = create(<RouterProvider router={router} />);
  });
  const current = renderer!.root.findAll(
    (node) => typeof node.type === "string" && node.props["aria-current"] === "page",
  );
  const links = renderer!.root.findAll((node) => node.type === "a");
  return { current, links };
}

it("has one aria-current in the header, the open chat's chip, while the strip shows", async () => {
  const { current, links } = await renderChatHeader([
    chip("t1", false),
    chip("t2", true),
    chip("t3", false),
  ]);
  expect(current.map((node) => node.props["data-chip-id"])).toEqual(["t2"]);
  // Back, three chips and All are all in the document, so the count above means something.
  expect(links.map((node) => node.props["aria-label"])).toEqual([
    "Back to Bots",
    "Chat t1",
    "Chat t2, current chat",
    "Chat t3",
    "All chats with Backend, 3 open",
  ]);
});

it("has no aria-current at all in the header of a one-chat bot (no strip)", async () => {
  const { current, links } = await renderChatHeader([chip("t2", true)]);
  expect(links.map((node) => node.props["aria-label"])).toEqual(["Back to Bots"]);
  expect(current).toEqual([]);
});
