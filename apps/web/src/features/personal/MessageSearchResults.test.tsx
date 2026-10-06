import type { EnvironmentId, PersonalBot, PersonalGroup } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MessageSearchResults } from "./MessageSearchResults";

const state = vi.hoisted(() => ({
  search: { status: "idle", hits: [], capped: false } as {
    status: string;
    hits: unknown[];
    capped: boolean;
  },
  shells: [] as Array<{ id: string; environmentId: string; title: string }>,
  jump: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    onClick?: () => void;
  }) => (
    <a
      data-to={to}
      data-params={JSON.stringify(params)}
      aria-label={(props as { "aria-label"?: string })["aria-label"]}
      onClick={onClick}
    >
      {children}
    </a>
  ),
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => state.shells }));
vi.mock("./useMessageSearch", () => ({ useMessageSearch: () => state.search }));
vi.mock("./pendingMessageJump", () => ({
  requestMessageJump: (...args: unknown[]) => state.jump(...args),
}));
vi.mock("./BotAvatar", () => ({
  BotAvatar: ({ label }: { label: string }) => <span data-avatar={label} />,
}));
vi.mock("./GroupAvatarCluster", () => ({
  GroupAvatarCluster: ({ memberCount, bots }: { memberCount: number; bots: unknown[] }) => (
    <span data-cluster={`${bots.length}/${memberCount}`} />
  ),
}));
vi.mock("./relativeTime", () => ({ formatRelativeTime: () => "3m" }));

const ENV = "env-1" as EnvironmentId;
const NOW = Date.parse("2026-10-06T10:00:00.000Z");

const bot = (botId: string, name: string) =>
  ({ botId, name, avatarShape: "round", avatarColor: "#fff" }) as unknown as PersonalBot;
const group = (groupId: string, name: string, memberIds: string[]) =>
  ({
    groupId,
    name,
    members: memberIds.map((botId, sortOrder) => ({ botId, sortOrder, leftAt: null })),
  }) as unknown as PersonalGroup;

const hit = (over: Record<string, unknown> = {}) => ({
  threadId: "thread-1",
  botId: "bot-1",
  groupId: null,
  messageId: "msg-1",
  role: "assistant",
  snippet: "…sent the Invoice yesterday",
  createdAt: DateTime.makeUnsafe(NOW - 180_000),
  archived: false,
  moreInChat: 0,
  ...over,
});

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.search = { status: "ready", hits: [hit()], capped: false };
  state.shells = [];
  state.jump.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function render(query = "invoice", groups: PersonalGroup[] = []) {
  await act(async () => {
    renderer = create(
      <MessageSearchResults
        environmentId={ENV}
        query={query}
        now={NOW}
        bots={[bot("bot-1", "Mori"), bot("bot-2", "Kai")]}
        groups={groups}
      />,
    );
  });
  return renderer!.root;
}

const links = (root: ReturnType<typeof create>["root"]) => root.findAllByType("a");

it("renders a bot hit as a row with the chat title, bot, snippet and time", async () => {
  state.shells = [{ id: "thread-1", environmentId: ENV, title: "Q3 billing" }];
  const root = await render();
  const section = root.findByProps({ "aria-label": "In messages" });
  expect(section.type).toBe("section");
  const [link] = links(root);
  expect(link!.props["data-to"]).toBe("/bots/$botId/$threadId");
  expect(JSON.parse(link!.props["data-params"])).toEqual({ botId: "bot-1", threadId: "thread-1" });
  expect(link!.props["aria-label"]).toBe("Q3 billing, Mori: …sent the Invoice yesterday");
  expect(root.findByType("time").children).toEqual(["3m"]);
  expect(root.findByProps({ "data-avatar": "Mori" })).toBeTruthy();
});

it("falls back to the bot name when the chat has no title yet", async () => {
  const root = await render();
  expect(links(root)[0]!.props["aria-label"]).toBe("Mori, Mori: …sent the Invoice yesterday");
});

it("emphasises the matched words without a highlight colour", async () => {
  const root = await render("INVOICE");
  const marks = root.findAllByType("mark");
  expect(marks).toHaveLength(1);
  expect(marks[0]!.children).toEqual(["Invoice"]);
  expect(marks[0]!.props.className).toContain("font-semibold");
  expect(marks[0]!.props.className).toContain("bg-transparent");
});

it("tags an archived chat and counts the other hits in it", async () => {
  state.search = { status: "ready", hits: [hit({ archived: true, moreInChat: 3 })], capped: false };
  const root = await render();
  const text = JSON.stringify(renderer!.toJSON());
  expect(text).toContain("Archived");
  expect(text).toContain("more in this chat");
  expect(root.findAllByType("li")).toHaveLength(1);
  expect(text).toContain("+3 more in this chat");
});

it("shows no more-in-chat line for a chat with one hit", async () => {
  await render();
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("more in this chat");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Archived");
});

it("renders a group hit with the member cluster and the group route", async () => {
  state.search = {
    status: "ready",
    hits: [hit({ threadId: "gt-1", botId: null, groupId: "grp-1", messageId: "msg-9" })],
    capped: false,
  };
  const root = await render("invoice", [
    group("grp-1", "Finance crew", ["bot-1", "bot-2", "gone"]),
  ]);
  const [link] = links(root);
  expect(link!.props["data-to"]).toBe("/bots/groups/$groupId");
  expect(JSON.parse(link!.props["data-params"])).toEqual({ groupId: "grp-1" });
  expect(link!.props["aria-label"]).toBe("Finance crew, Finance crew: …sent the Invoice yesterday");
  expect(root.findByProps({ "data-cluster": "2/3" })).toBeTruthy();
});

it("titles a group hit with the group's name, not its thread's \"Group chat\"", async () => {
  state.shells = [{ id: "gt-1", environmentId: ENV, title: "Group chat" }];
  state.search = {
    status: "ready",
    hits: [hit({ threadId: "gt-1", botId: null, groupId: "grp-1", messageId: "msg-9" })],
    capped: false,
  };
  const root = await render("invoice", [group("grp-1", "QA Kiwi Group", ["bot-1"])]);
  expect(links(root)[0]!.props["aria-label"]).toBe(
    "QA Kiwi Group, QA Kiwi Group: …sent the Invoice yesterday",
  );
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Group chat");
  state.shells = [];
});

it("keeps the order it was given and skips a chat whose bot or group is unknown", async () => {
  state.search = {
    status: "ready",
    hits: [
      hit({ threadId: "t-b", botId: "bot-2", messageId: "m-b" }),
      hit({ threadId: "t-gone", botId: "bot-gone", messageId: "m-gone" }),
      hit({ threadId: "t-g", botId: null, groupId: "grp-gone", messageId: "m-g" }),
      hit({ threadId: "t-a", botId: "bot-1", messageId: "m-a" }),
    ],
    capped: false,
  };
  const root = await render();
  expect(links(root).map((link) => JSON.parse(link.props["data-params"]).threadId)).toEqual([
    "t-b",
    "t-a",
  ]);
});

it("asks the chat to scroll to the message when the row is tapped", async () => {
  const root = await render();
  await act(async () => links(root)[0]!.props.onClick());
  expect(state.jump).toHaveBeenCalledWith("thread-1", "msg-1");
});

it("says so when the search stopped at its cap", async () => {
  state.search = { status: "ready", hits: [hit()], capped: true };
  await render();
  expect(JSON.stringify(renderer!.toJSON())).toContain(
    "Showing the newest matches. Narrow the search for more.",
  );
});

it("renders nothing while idle, empty or failed", async () => {
  for (const status of ["idle", "ready", "error"]) {
    state.search = { status, hits: [], capped: false };
    await render();
    expect(renderer!.toJSON()).toBeNull();
    await act(async () => renderer!.unmount());
    renderer = undefined;
  }
});

it("shows a quiet status line while loading with nothing to show yet", async () => {
  state.search = { status: "loading", hits: [], capped: false };
  const root = await render();
  expect(root.findByProps({ role: "status" }).children).toEqual(["Searching in messages..."]);
});

it("keeps the previous hits up while the next search loads", async () => {
  state.search = { status: "loading", hits: [hit()], capped: false };
  const root = await render();
  expect(links(root)).toHaveLength(1);
  expect(root.findAllByProps({ role: "status" })).toHaveLength(0);
});
