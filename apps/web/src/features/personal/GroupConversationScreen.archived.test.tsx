import * as Option from "effect/Option";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { GroupConversationScreen } from "./GroupConversationScreen";

const state = vi.hoisted(() => ({
  archivedAt: "2026-10-01T10:00:00.000Z" as string | null,
  commands: [] as Array<{ input: unknown }>,
}));

const group = () => ({
  groupId: "group-1",
  name: "Planning",
  threadId: "group-thread-1",
  archivedAt: state.archivedAt,
  members: [],
  createdAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select: (location: { state: unknown }) => unknown }) =>
    select({ state: undefined }),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSeparator: () => <hr />,
}));
vi.mock("~/state/entities", () => ({
  useThreadDetail: () => ({ messages: [], activities: [], proposedPlans: [], session: null }),
  useThreadStatus: () => "ready",
  useThreadShells: () => [],
}));
vi.mock("~/state/threads", () => ({
  useEnvironmentThread: () => ({
    status: "ready",
    data: Option.none(),
    error: Option.none(),
    page: Option.none(),
  }),
  useRetryEnvironmentThread: () => () => undefined,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (args: { input: unknown }) => {
    state.commands.push(args);
    return Promise.resolve({ _tag: "Success", value: {} });
  },
}));
vi.mock("./usePersonalBots", () => ({
  personalBotCreateThread: {},
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [], threads: [] } }),
}));
vi.mock("./usePersonalGroups", () => ({
  personalGroupSendMessage: {},
  personalGroupContinueRound: {},
  personalGroupStop: {},
  personalGroupUpdate: {},
  personalGroupDelete: {},
  personalGroupAddMember: {},
  personalGroupRemoveMember: {},
  usePersonalGroupsList: () => ({ data: { groups: [], rounds: [], votes: [] }, error: null }),
  usePersonalGroupsFeed: () => ({ feed: null }),
  mergePersonalGroups: () =>
    state.archivedAt === null
      ? { groups: [group()], archivedGroups: [], rounds: [], votes: [] }
      : { groups: [], archivedGroups: [group()], rounds: [], votes: [] },
}));
// A parked round with a Continue card and an open vote: both start work, so
// an archived group must not offer them.
vi.mock("./groupModel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./groupModel")>()),
  groupRoundCard: () => ({ kind: "parked" }),
  groupVoteCard: () => ({ voteId: "vote-1" }),
}));
vi.mock("./GroupRoundCard", () => ({ GroupRoundCard: () => <div data-round-card="" /> }));
vi.mock("./GroupVoteCard", () => ({ GroupVoteCard: () => <div data-vote-card="" /> }));
vi.mock("./GroupDeleteSheet", () => ({ GroupDeleteSheet: () => <div data-delete-sheet="" /> }));
vi.mock("./MessageList", () => ({
  MessageList: (props: { readOnly?: boolean }) => (
    <div data-message-list="" data-read-only={String(props.readOnly === true)} />
  ),
}));
vi.mock("./PersonalComposer", () => ({ PersonalComposer: () => <div data-composer="" /> }));
vi.mock("./PersonalOfflineBanner", () => ({
  useLaptopOffline: () => false,
  usePersonalConnectionPhase: () => "connected",
}));
vi.mock("./useReportViewingThread", () => ({ useReportViewingThread: () => {} }));
vi.mock("./useKeyboardInset", () => ({ useKeyboardInset: () => 0 }));
vi.mock("./GroupAvatarCluster", () => ({ GroupAvatarCluster: () => <div /> }));

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  state.archivedAt = "2026-10-01T10:00:00.000Z";
  state.commands.length = 0;
});

const render = async () => {
  await act(async () => {
    renderer = create(<GroupConversationScreen groupId="group-1" />);
  });
  return renderer!;
};

const buttonWithText = (root: ReactTestRenderer, text: string) =>
  root.root.find(
    (node) =>
      node.type === "button" &&
      node.children.some((child) => typeof child === "string" && child === text),
  );

it("opens an archived group read-only: no composer, no round or vote card, nothing sent", async () => {
  const root = await render();
  const text = JSON.stringify(root.toJSON());
  expect(text).toContain("Archived.");
  expect(root.root.findAll((node) => node.props["data-composer"] !== undefined)).toHaveLength(0);
  expect(root.root.findAll((node) => node.props["data-round-card"] !== undefined)).toHaveLength(0);
  expect(root.root.findAll((node) => node.props["data-vote-card"] !== undefined)).toHaveLength(0);
  expect(root.root.findByProps({ "data-message-list": "" }).props["data-read-only"]).toBe("true");
  expect(state.commands).toEqual([]);
});

it("Unarchive restores the group in place and the composer comes back", async () => {
  const root = await render();
  await act(async () => {
    buttonWithText(root, "Unarchive").props.onClick();
  });
  expect(state.commands).toEqual([
    { environmentId: "env-1", input: { groupId: "group-1", archived: false } },
  ]);
  state.archivedAt = null;
  await act(async () => {
    root.update(<GroupConversationScreen groupId="group-1" />);
  });
  expect(root.root.findAll((node) => node.props["data-composer"] !== undefined)).toHaveLength(1);
  expect(JSON.stringify(root.toJSON())).not.toContain("Archived.");
});

it("Delete opens the existing delete confirm instead of deleting at once", async () => {
  const root = await render();
  await act(async () => {
    buttonWithText(root, "Delete").props.onClick();
  });
  expect(root.root.findAll((node) => node.props["data-delete-sheet"] !== undefined)).toHaveLength(
    1,
  );
  expect(state.commands).toEqual([]);
});
