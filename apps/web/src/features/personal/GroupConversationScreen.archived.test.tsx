import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { GroupConversationScreen } from "./GroupConversationScreen";

const state = vi.hoisted(() => ({
  archivedAt: "2026-10-01T10:00:00.000Z" as string | null,
  commands: [] as Array<{ input: unknown }>,
  pinnedAt: null as string | null,
  navigate: (() => {}) as (...args: unknown[]) => unknown,
}));

const group = () => ({
  groupId: "group-1",
  name: "Planning",
  threadId: "group-thread-1",
  archivedAt: state.archivedAt,
  ...(state.pinnedAt === null ? {} : { pinnedAt: state.pinnedAt }),
  members: [],
  createdAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => state.navigate,
  useLocation: ({ select }: { select: (location: { state: unknown }) => unknown }) =>
    select({ state: undefined }),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" data-menu-item="" onClick={onClick}>
      {children}
    </button>
  ),
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
vi.mock("./SnoozeSheet", () => ({
  SnoozeSheet: ({
    onPick,
    onCancel,
  }: {
    onPick: (untilMs: number) => void;
    onCancel: () => void;
  }) => (
    <div data-snooze-sheet="">
      <button type="button" data-pick="" onClick={() => onPick(1_800_000_000_000)} />
      <button type="button" data-cancel="" onClick={onCancel} />
    </div>
  ),
}));
vi.mock("./GroupAvatarCluster", () => ({ GroupAvatarCluster: () => <div /> }));

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.navigate = vi.fn(async () => undefined);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  state.archivedAt = "2026-10-01T10:00:00.000Z";
  state.commands.length = 0;
  state.pinnedAt = null;
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

// Pin and snooze in the group's menu (a group has no unread state, so no Mark unread).
const menuText = (root: ReactTestRenderer) =>
  root.root
    .findAll((node) => node.props["data-menu-item"] === "")
    .map((node) => node.children.join(""));

it("offers Pin group and Snooze on an open group, no Mark unread, and neither on an archived one", async () => {
  const archivedRoot = await render();
  expect(menuText(archivedRoot)).not.toContain("Pin group");
  expect(menuText(archivedRoot)).not.toContain("Snooze…");
  await act(async () => archivedRoot.unmount());

  state.archivedAt = null;
  const root = await render();
  expect(menuText(root)).toContain("Pin group");
  expect(menuText(root)).toContain("Snooze…");
  expect(menuText(root)).not.toContain("Mark unread");
});

it("Pin group pins it and stays; a pinned group offers Unpin group", async () => {
  state.archivedAt = null;
  const root = await render();
  await act(async () => {
    buttonWithText(root, "Pin group").props.onClick();
  });
  expect(state.commands).toEqual([
    { environmentId: "env-1", input: { groupId: "group-1", pinned: true } },
  ]);
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => root.unmount());

  state.commands.length = 0;
  state.pinnedAt = "2026-10-02T10:00:00.000Z";
  const pinned = await render();
  expect(menuText(pinned)).not.toContain("Pin group");
  await act(async () => {
    buttonWithText(pinned, "Unpin group").props.onClick();
  });
  expect(state.commands).toEqual([
    { environmentId: "env-1", input: { groupId: "group-1", pinned: false } },
  ]);
});

it("Snooze asks when, snoozes the group until then and leaves it like Archive does", async () => {
  state.archivedAt = null;
  const root = await render();
  await act(async () => {
    buttonWithText(root, "Snooze…").props.onClick();
  });
  await act(async () => {
    root.root.find((node) => node.props["data-pick"] === "").props.onClick();
  });
  expect(state.commands).toHaveLength(1);
  const input = (state.commands[0] as { input: { groupId: string; snoozedUntil: DateTime.Utc } })
    .input;
  expect(input.groupId).toBe("group-1");
  expect(DateTime.toEpochMillis(input.snoozedUntil)).toBe(1_800_000_000_000);
  expect(state.navigate).toHaveBeenCalledWith({ to: "/bots", replace: true });
});

it("cancelling the snooze sheet sends nothing", async () => {
  state.archivedAt = null;
  const root = await render();
  await act(async () => {
    buttonWithText(root, "Snooze…").props.onClick();
  });
  await act(async () => {
    root.root.find((node) => node.props["data-cancel"] === "").props.onClick();
  });
  expect(state.commands).toEqual([]);
  expect(root.root.findAll((node) => node.props["data-snooze-sheet"] !== undefined)).toHaveLength(
    0,
  );
});
