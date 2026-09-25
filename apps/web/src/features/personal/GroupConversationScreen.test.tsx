import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { GroupConversationScreen } from "./GroupConversationScreen";

const state = vi.hoisted(() => ({
  threadRequests: [] as Array<string | null>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSeparator: () => <hr />,
}));
vi.mock("~/state/entities", () => ({
  useThreadDetail: () => null,
  useThreadStatus: () => "loading",
  useThreadShells: () => [],
}));
vi.mock("~/state/threads", () => ({
  useEnvironmentThread: (_environmentId: string | null, threadId: string | null) => {
    state.threadRequests.push(threadId);
    return {};
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
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
  mergePersonalGroups: () => ({ groups: [], rounds: [], votes: [] }),
}));
vi.mock("./PersonalOfflineBanner", () => ({
  useLaptopOffline: () => false,
  usePersonalConnectionPhase: () => "connected",
}));
vi.mock("./useReportViewingThread", () => ({ useReportViewingThread: () => {} }));
vi.mock("./useKeyboardInset", () => ({ useKeyboardInset: () => 0 }));
vi.mock("./GroupAvatarCluster", () => ({ GroupAvatarCluster: () => <div /> }));

afterEach(() => {
  vi.unstubAllGlobals();
  state.threadRequests.length = 0;
});

it("does not subscribe to a made-up thread when a deleted group disappears", async () => {
  vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(<GroupConversationScreen groupId="deleted-group" />);
  });

  expect(state.threadRequests).toEqual([null]);
  expect(JSON.stringify(renderer!.toJSON())).toContain("This group no longer exists.");

  await act(async () => renderer!.unmount());
});
