import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { BotThreadsScreen } from "./BotThreadsScreen";
import { markChatOpen, resetChatSeenState } from "./unreadChats";

const state = vi.hoisted(() => ({
  archive: (() => {}) as (...args: unknown[]) => unknown,
  otherCommand: (() => {}) as (...args: unknown[]) => unknown,
  deleteChat: (() => {}) as (...args: unknown[]) => unknown,
  lead: true,
}));

const ARCHIVE_COMMAND = vi.hoisted(() => ({ name: "personalBotArchiveThread" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a
      data-to={to}
      data-params={params === undefined ? undefined : JSON.stringify(params)}
      aria-label={(props as { "aria-label"?: string })["aria-label"]}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/state/entities", () => ({
  useThreadDetail: () => null,
  useThreadShells: () => [],
}));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === ARCHIVE_COMMAND ? state.archive : state.otherCommand,
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./botModelLabel", () => ({
  botModelShortLabel: () => null,
  botActiveModelShortLabel: () => null,
  fallbackNoteLabel: () => null,
}));
const makeReply = vi.hoisted(() => () => new Date(Date.UTC(2026, 9, 2, 10, 5)));
vi.mock("effect/DateTime", () => ({ toEpochMillis: (value: Date) => value.getTime() }));
vi.mock("./botThreadRows", () => {
  const row = (threadId: string, title: string, archivedAt: string | null, unread = true) => ({
    link: {
      botId: "bot-a",
      threadId,
      archivedAt,
      ...(unread ? { unread: true, lastReplyAt: makeReply() } : {}),
    },
    shell: { id: threadId, title, archivedAt, environmentId: "env-1" },
    updatedMs: Date.UTC(2026, 8, 30, 10),
  });
  return {
    botThreadRows: () => ({
      active: [row("thread-open", "Open chat", null), row("thread-read", "Read chat", null, false)],
      archived: [row("thread-archived", "Old plans", "2026-09-30T10:00:00.000Z")],
      snoozed: [],
    }),
  };
});
vi.mock("./usePersonalGroups", () => ({
  usePersonalGroupRelayThreadIds: () => new Set<string>(),
}));
vi.mock("./botSummaries", () => ({
  isThreadLive: () => false,
  isThreadRateLimited: () => false,
  threadNeedsAttention: () => false,
}));
vi.mock("./relativeTime", () => ({ formatRelativeTime: () => "Yesterday" }));
vi.mock("./startBotChat", () => ({
  useStartBotChat: () => ({ start: async () => undefined, starting: false }),
}));
vi.mock("./PersonalOfflineBanner", () => ({ useLaptopOffline: () => false }));
vi.mock("./usePersonalAutomation", () => ({ usePersonalTasks: () => ({ tasks: null }) }));
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
vi.mock("./usePersonalBots", () => ({
  personalBotArchiveThread: ARCHIVE_COMMAND,
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: {
      bots: [
        {
          botId: "bot-a",
          name: "Ada",
          avatarShape: "pill",
          avatarColor: "#E8711A",
          modelSelection: {},
          lead: state.lead,
        },
      ],
      threads: [],
    },
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("./wrapupChat", () => ({
  useWrapupChat: () => ({ send: async () => true, sending: false }),
}));
vi.mock("./useDeleteChat", () => ({ useDeleteChat: () => state.deleteChat }));
vi.mock("./SwipeToDelete", () => ({
  SwipeToDelete: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./useBulkChatActions", () => ({ useBulkChatActions: () => async () => undefined }));
vi.mock("./usePersonalBackTarget", () => ({
  usePersonalBackTarget: () => ({ to: "/bots", label: "Back to Bots" }),
}));

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.archive = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.otherCommand = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.deleteChat = vi.fn(async () => ({ status: "cancelled" }));
  state.lead = true;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  resetChatSeenState();
  vi.unstubAllGlobals();
});

/** Thread ids of the rows that carry an unread dot. */
function dottedThreads(): string[] {
  return renderer!.root
    .findAll((node) => node.type === "a" && node.props["data-to"] === "/bots/$botId/$threadId")
    .filter((link) => link.findAll((node) => node.props["data-testid"] === "unread-dot").length > 0)
    .map((link) => JSON.parse(link.props["data-params"] as string).threadId as string);
}

it("an unread chat carries a dot; read and archived ones do not", async () => {
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  expect(dottedThreads()).toEqual(["thread-open"]);
  // Spoken too, not only drawn.
  expect(JSON.stringify(renderer!.toJSON())).toContain(", unread");
});

it("a bot that is not a lead shows the same dots the chat chips mark unread (1.60.45)", async () => {
  state.lead = false;
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  expect(dottedThreads()).toEqual(["thread-open"]);
  expect(JSON.stringify(renderer!.toJSON())).toContain(", unread");
});

it("the dot clears once the chat has been opened on this device, without a refetch", async () => {
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  expect(dottedThreads()).toEqual(["thread-open"]);
  await act(async () => {
    markChatOpen("thread-open", true);
  });
  expect(dottedThreads()).toEqual([]);
  await act(async () => {
    markChatOpen("thread-open", false, Date.UTC(2026, 9, 2, 10, 6));
  });
  expect(dottedThreads()).toEqual([]);
});
